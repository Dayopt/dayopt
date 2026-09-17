#!/bin/bash

# PR のマージ〜掃除をワンセットで行う共通スクリプト。
# Claude / 人間が同じコマンドで実行できる。
#
#   pnpm branch:finish <PR番号> [--dry-run]
#
# 完了定義（5点すべてを満たして初めて「作業終了」）:
#   ① PR マージ済み
#   ② worktree 削除
#   ③ ローカル branch 削除
#   ④ リモート branch 消滅（fetch --prune で確認）
#   ⑤ ローカル main ref が origin/main と一致
#
# 詳細な設計と手動フォールバックは AGENTS.md §PR / git 運用 を参照。

set -euo pipefail

DRY_RUN=false
PR_NUMBER=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    -h | --help)
      cat <<'EOF'
Usage: pnpm branch:finish <PR番号> [--dry-run]

PR をマージし、worktree・ローカル branch・リモート branch を掃除して main を最新化する。

  <PR番号>     掃除対象の Pull Request 番号（必須）
  --dry-run    実際には変更せず、実行予定のアクションだけ表示する
EOF
      exit 0
      ;;
    *)
      if [[ -z "$PR_NUMBER" ]]; then
        PR_NUMBER="$arg"
      else
        echo "❌ 引数が多すぎます: $arg" >&2
        exit 1
      fi
      ;;
  esac
done

# `branch -d` の stderr を退避する一時ファイル。固定パスにすると並行実行で
# 互いに上書きし合い、共有 /tmp では symlink 差し替えの的にもなる。
BRANCH_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/branch-finish-err.XXXXXX")"
trap 'rm -f "$BRANCH_ERR_FILE"' EXIT

error() {
  echo "❌ $1" >&2
}

info() {
  echo "ℹ️  $1" >&2
}

step() {
  echo "" >&2
  echo "▶ $1" >&2
}

# --dry-run 時はコマンドを実行せず表示だけする
run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "   [dry-run] $*" >&2
  else
    "$@"
  fi
}

if [[ -z "$PR_NUMBER" ]]; then
  error "PR 番号を指定してください: pnpm branch:finish <PR番号> [--dry-run]"
  exit 1
fi

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  error "PR 番号は数値で指定してください（受け取った値: ${PR_NUMBER}）"
  exit 1
fi

for bin in git gh jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    error "$bin が見つかりません。"
    exit 1
  fi
done

# repo のルート（main checkout）を git-common-dir から解決する。
# worktree の中から実行しても main checkout を正しく指す。
GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
MAIN_ROOT="$(cd "$(dirname "$GIT_COMMON_DIR")" && pwd)"

# feature worktree の中から実行された場合、後段の worktree remove が自分の cwd を
# 消して以降の git 操作が壊れる。先頭で main checkout へ移動して基準を揃える
# （bash は script の fd を開いたまま読むため、実行元 worktree の削除後も安全）。
cd "$MAIN_ROOT"

if [[ "$DRY_RUN" == true ]]; then
  info "dry-run モード: 変更は行いません"
fi

# ── 1. PR 状態を取得 ────────────────────────────────────────────────
step "PR #$PR_NUMBER の状態を確認"

PR_JSON="$(gh pr view "$PR_NUMBER" --json state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,changedFiles,labels 2>/dev/null || true)"

if [[ -z "$PR_JSON" ]]; then
  error "PR #$PR_NUMBER を取得できませんでした。番号とネットワークを確認してください。"
  exit 1
fi

PR_STATE="$(printf '%s' "$PR_JSON" | jq -r '.state')"
IS_DRAFT="$(printf '%s' "$PR_JSON" | jq -r '.isDraft // false')"
BRANCH="$(printf '%s' "$PR_JSON" | jq -r '.headRefName')"
HEAD_SHA="$(printf '%s' "$PR_JSON" | jq -r '.headRefOid // ""')"
BASE_REF="$(printf '%s' "$PR_JSON" | jq -r '.baseRefName // "main"')"

if [[ -z "$BRANCH" || "$BRANCH" == "null" ]]; then
  error "PR #$PR_NUMBER の head branch を特定できませんでした。"
  exit 1
fi

info "branch: $BRANCH / state: $PR_STATE"

if [[ "$PR_STATE" == "CLOSED" ]]; then
  info "PR は CLOSED（未マージ）です。branch 掃除のみ続行します。"
fi

# ── 2. 未マージなら checks を確認してマージ ──────────────────────────
if [[ "$PR_STATE" == "OPEN" ]]; then
  step "PR #$PR_NUMBER をマージ"

  # `gh pr merge` はクライアント側で draft を拒否するが、REST 直叩きにはその防御が無い。
  # draft では skip される check がある（ci.yml の重量 job、production-config-audit）
  # ため、ここで明示的に止める。
  if [[ "$IS_DRAFT" == "true" ]]; then
    error "PR #$PR_NUMBER は draft です。ready にしてから再実行してください。"
    exit 1
  fi

  # head SHA は check 判定と compare gate の基準に使う。取れなければ何も判定できない。
  # 40 桁 hex であることも検証する（merge 実行時に `-f sha=$HEAD_SHA` として REST へ
  # そのまま渡すため、想定外の値が紛れ込むと merge 自体が壊れる）。
  if [[ -z "$HEAD_SHA" || "$HEAD_SHA" == "null" || ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    error "PR #$PR_NUMBER の head SHA を取得できませんでした。マージを中止します。"
    exit 1
  fi

  # ── statusCheckRollup を name / context ごとに 1 件へ畳む ──────────
  #
  # **同一 head SHA で 2 回以上 run が走ると、古い run の entry が残り続ける。**
  # `gh pr checks` は同名を畳むが `gh pr view --json statusCheckRollup` は畳まない
  # （2026-07-30 実測: PR #1765 は check-runs 18 件のうち 8 名前が重複し、
  # rollup 21 件に対して `gh pr checks` は 13 行）。畳まずに数えると、再実行で
  # 解決済みの failure / cancelled を永久に数え続けてマージ不能になる。
  # 同一 SHA で 2 回走る経路は現実にある: ラベル付与での再発火、draft → ready、
  # ready → draft → ready、手動 re-run、reopened。
  #
  # 畳み方には 2 つの非対称性を持たせる。どちらも「緩む側へ倒れない」ためのもの。
  #
  # ① **pending は「どれか 1 つでも実行中なら実行中」** として扱う。queued な run は
  #    startedAt を持たないことがあり、単純な「最新」判定では古い完了 run が勝つ
  #    （= 実行中の run を見落として素通りする fail-open）。
  # ② **完了済みの代表は「判定を持つ entry」を優先する。** `skipped` / `neutral` /
  #    `stale` は失敗にも成功にも数えないため、これが代表になると同じ名前の古い
  #    failure が消える。job-level `if:` で skip された run は同一 SHA に
  #    `conclusion: skipped` の check run を作るので、これは実在する経路
  #    （例: ci.yml の重量 job は draft PR で skip する。ready で FAILURE → draft へ戻して
  #    reopen すると skipped が後から積まれ、blocking な赤が消えてしまう）。
  #
  # 畳む単位は `gh pr checks` の dedupe に合わせ、型 + workflow 名 + check 名。
  # 名前を特定できない entry は畳まず全件残す（identity 不明を fail-closed 側へ倒す）。
  ROLLUP="$(printf '%s' "$PR_JSON" | jq -c '
    def is_pending:
      ((.status // "") | ascii_downcase
        | . == "in_progress" or . == "queued" or . == "pending" or . == "waiting" or . == "requested")
      or ((.state // "") | ascii_downcase | . == "pending" or . == "expected");
    def is_decisive:
      ((.conclusion // "") | ascii_downcase
        | . == "success" or . == "failure" or . == "cancelled" or . == "timed_out")
      or ((.state // "") | ascii_downcase | . == "success" or . == "failure" or . == "error");
    def check_name: (.name // .context // "");
    [ (.statusCheckRollup // [])
      | group_by([(.__typename // ""), (.workflowName // ""), check_name])
      | .[]
      | if (.[0] | check_name) == "" then .[]
        elif any(.[]; is_pending) then (map(select(is_pending)) | .[0])
        else ((map(select(is_decisive)) | max_by(.startedAt // "")) // max_by(.startedAt // ""))
        end
    ]')"

  if [[ -z "$ROLLUP" ]]; then
    error "check 一覧を解析できませんでした。gh pr checks $PR_NUMBER で状態を確認してください。"
    exit 1
  fi

  # 失敗している check がないか確認する（CheckRun は .conclusion、StatusContext は .state を持つ）。
  #
  # ── 唯一の免除: trusted dispatch で解除済みの audit guard ──────────
  #
  # production-config-audit.yml は audit contract 保護対象（audit script /
  # production-build-gate / workflow 自身）を変更する PR で、pull_request_target の
  # check run「Audit Vercel metadata (trusted)」を**設計として必ず failure にする**
  # （PR code に contract 変更を自己検証させないため）。解除経路は
  # `gh workflow run production-config-audit.yml --ref <branch>` の trusted dispatch で、
  # 成功すると commit status「Production Config Audit」が head SHA へ success で
  # 発行される。しかし workflow_dispatch run の check run は PR の rollup に
  # 紐づかないため、rollup には pull_request_target 側の failure だけが残り続け、
  # 畳み込みでは解消できない（別 run が rollup に存在しないので代表になれない）。
  #
  # そこで status「Production Config Audit」が success の時に限り、この 1 check の
  # failure を数えから除外する。fail-closed の根拠:
  #   (a) audit が本当に落ちた PR では status も failure になる → 免除は発動しない
  #   (b) contract 変更 PR で dispatch 未実行なら status は
  #       「trusted head audit is required」の failure のまま → 発動しない
  #   (c) status は SHA ごとに発行されるため、新しい push では guard の failure だけが
  #       付き直り、免除は自動的にリセットされる（push ごとに dispatch が要る）
  # 照合は 型 + workflow 名 + check 名 / context の**完全一致のみ**。
  # 他の check の failure はこの免除では消えない。
  #
  # 免除対象は guard の `conclusion: failure` **だけ**に絞る。設計上の意図的 failure は
  # enforce step の exit 1 が作る failure のみで、cancelled / timed_out は「監査が
  # 完走していない」状態にすぎない。これらまで免除すると、古い run の success status が
  # 残ったまま再発火 run が publish 前に cancel された時に、監査されていない commit が
  # 素通りする（fail-open）。cancelled / timed_out は従来どおり停止し、再実行を強制する。
  JQ_GATE_DEFS='
    def is_failed:
      ((.conclusion // "") | ascii_downcase | . == "failure" or . == "cancelled" or . == "timed_out")
      or ((.state // "") | ascii_downcase | . == "failure" or . == "error");
    def trusted_audit_cleared:
      any(.[];
        (.__typename // "") == "StatusContext"
        and (.context // "") == "Production Config Audit"
        and ((.state // "") | ascii_downcase) == "success");
    def is_trusted_audit_guard_failure:
      (.__typename // "") == "CheckRun"
      and (.workflowName // "") == "Production Config Audit"
      and (.name // "") == "Audit Vercel metadata (trusted)"
      and ((.conclusion // "") | ascii_downcase) == "failure";
  '

  TRUSTED_AUDIT_EXEMPTED="$(printf '%s' "$ROLLUP" | jq -r "$JQ_GATE_DEFS"'
    if trusted_audit_cleared
    then map(select(is_trusted_audit_guard_failure)) | length
    else 0 end')"

  if [[ "$TRUSTED_AUDIT_EXEMPTED" != "0" ]]; then
    info "check「Audit Vercel metadata (trusted)」の failure は trusted dispatch により解除済みです（status「Production Config Audit」= success）。失敗数から除外します。"
  fi

  FAILED_CHECKS="$(printf '%s' "$ROLLUP" | jq -r "$JQ_GATE_DEFS"'
    (if trusted_audit_cleared
     then map(select(is_failed and (is_trusted_audit_guard_failure | not)))
     else map(select(is_failed)) end)
    | length')"

  if [[ "$FAILED_CHECKS" != "0" ]]; then
    error "失敗している check が $FAILED_CHECKS 件あります。マージを中止します。"
    error "gh pr checks $PR_NUMBER で詳細を確認してください。"
    exit 1
  fi

  # branch が main の最新を含んでいるか確認する（up-to-date gate）。
  # CI は PR 側でしか走らせないため、古い main ベースのままマージすると
  # 「A・B 単体では green だが合わせると壊れる」マージ順衝突を検知できない。
  # branch protection の strict mode 相当をここで代替する。
  #
  # 比較対象は branch 名ではなく **実際にマージする SHA** に固定する。branch 名で見ると、
  # 判定とマージの間に main 取り込みが push された場合に「新しい tip は ahead」と判定して
  # 「main を含まない古い SHA」をマージしてしまい、gate だけがすり抜ける。
  BASE_STATUS="$(gh api "repos/{owner}/{repo}/compare/main...$HEAD_SHA" --jq '.status' 2>/dev/null || echo unknown)"
  if [[ "$BASE_STATUS" != "ahead" && "$BASE_STATUS" != "identical" ]]; then
    error "branch が main の最新を含んでいません（compare status: ${BASE_STATUS}）。"
    error "main を取り込んで push し、CI green を待ってから再実行してください:"
    error "  git fetch origin && git merge origin/main && git push"
    exit 1
  fi

  # 実行中・待機中の check も待つ。main の ruleset も pending の required check を
  # 拒むが、ここでも止めて「なぜ止まったか」を名前で示す（#2640 以降、gate は ruleset）。
  # 畳み込み側の is_pending（§ROLLUP）と同じ集合にする。片方だけ直すと
  # 「代表は pending だが件数は 0」のようなズレが出る。`expected` は
  # StatusState の「status 到着待ち」で、failure でも success でもない。
  PENDING_CHECKS="$(printf '%s' "$ROLLUP" | jq -r '
    map(select(
        ((.status // "") | ascii_downcase | . == "in_progress" or . == "queued" or . == "pending" or . == "waiting" or . == "requested")
        or ((.state // "") | ascii_downcase | . == "pending" or . == "expected")
      ))
    | length')"

  if [[ "$PENDING_CHECKS" != "0" ]]; then
    error "実行中の check が $PENDING_CHECKS 件あります。完了を待ってから再実行してください。"
    error "gh pr checks $PR_NUMBER --watch で完了を待てます。"
    exit 1
  fi

  # 検証が実際に行われたことを確認する。statusCheckRollup が空、または全ての
  # check が skipped の場合、上の failure / pending 判定はどちらも 0 件になり
  # 「CI が 1 本も走っていない PR」を green と区別できないまま素通りする。
  # main の ruleset は required check が存在しない PR を expected のまま止めるが、
  # ここでも「success が 1 件も無い」構成異常を名前で検出する（冗長検査）。
  #
  # ci.yml は docs のみの変更なら paths-ignore で skip されるので、「CI が
  # 走らない PR」自体は異常ではない。ただし Docs Guard は paths フィルタを持たず
  # 全 PR で走るため、success が 1 件も無い状態は構成の異常を意味する。
  SUCCESS_CHECKS="$(printf '%s' "$ROLLUP" | jq -r '
    map(select(
        ((.conclusion // "") | ascii_downcase | . == "success")
        or ((.state // "") | ascii_downcase | . == "success")
      ))
    | length')"

  if [[ "$SUCCESS_CHECKS" == "0" ]]; then
    error "成功した check が 1 件もありません。マージを中止します。"
    error "CI が未登録、全て skip、または check 登録前の可能性があります。"
    error "gh pr checks $PR_NUMBER で状態を確認してください。"
    exit 1
  fi

  # **product / web の build は Vercel でしか検証されない。** Actions 側の無条件
  # build は 2026-08-03 に撤去し、Next build と bundle 検査（secret 混入 /
  # JS budget / CSS budget）は `apps/product/vercel.json` の buildCommand へ移した
  # （build と bundle 検査は Vercel 側で走る）。
  #
  # このため affected な project の context が **付かなかった場合**、上の「成功 1 件
  # 以上」は Static / Unit / Docs Guard だけで満たされ、build が一度も走らないまま
  # merge できてしまう（fail-open）。status が付かない経路は実在する: Vercel
  # integration の切断・障害、Ignored Build Step の設定、project rename。
  # Vercel context は ruleset でも required だが、affected な project の判定は
  # Impact Resolver が持つため、「あるはずの context が無い」ことをここでも検出する。
  #
  # **どの context を「あるはず」とするかは Impact Resolver が決める**
  # （scripts/ci/impact.mjs。旧 docs/projects/_archive/ci-monorepo-refactor/overview.md §5、
  #   docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
  # PR の変更ファイルから affected な app を判定し、affected な project の context
  # だけを必須にする。unaffected な project の context 欠落は正常（Vercel の
  # Skip deployment 導入後はこれが通常状態になる）。判定に失敗した場合
  # （files API 不通 / node 不在 / 出力が解釈不能）は従来どおり両方を必須にする
  # （fail closed。Vercel の判定ではなく Dayopt 側の判定を正とする設計原則）。
  step "影響範囲を判定"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  IMPACT_RESOLVER="$SCRIPT_DIR/../ci/impact.mjs"

  IMPACT_PRODUCT="true"
  IMPACT_WEB="true"

  # **rename では移動元（previous_filename）も影響範囲に含める。** 移動先だけを見ると
  # `apps/product/foo.ts` → `docs/foo.ts` の rename が docs-only と判定され、ファイルが
  # 消えた側の app の build を検証しないまま merge できる（fail-open）。
  #
  # 行頭マーカーで「ファイル本体（F）」と「rename 元（P）」を区別する。F の件数を
  # PR の changedFiles と突き合わせ、取得漏れ（後述）を検出するために要る。
  #
  # `|| true` で握り潰さない。`gh api --paginate` はページごとに stdout へ流すため、
  # 2 ページ目以降の失敗では「部分的なファイル一覧 + 非 0 終了」になる。終了コード
  # だけ潰すと不完全な一覧が「取得成功」として通り、後半ページにだけ含まれる
  # app の context を要求しないまま merge できてしまう。
  # 失敗時は空へ明示リセットし、「取得不能 → 両方必須」の経路に合流させる。
  if ! CHANGED_FILES_RAW="$(gh api --paginate "repos/{owner}/{repo}/pulls/$PR_NUMBER/files" \
    --jq '.[] | "F\t\(.filename)", (if .previous_filename then "P\t\(.previous_filename)" else empty end)' 2>/dev/null)"; then
    CHANGED_FILES_RAW=""
  fi

  # **files endpoint は `--paginate` でも 3,000 件で打ち切られ、その状態で成功終了する。**
  # 打ち切りを「完全な一覧」と扱うと、3,000 件目以降にだけ現れる app の context を
  # 要求しないまま merge できる。PR の申告件数と取得件数の一致を要求し、ズレたら
  # fail closed に倒す（3,000 件上限に限らず、あらゆる silent truncation を捕まえる）。
  if [[ -n "$CHANGED_FILES_RAW" ]]; then
    RETRIEVED_FILE_COUNT="$(printf '%s\n' "$CHANGED_FILES_RAW" | grep -c "$(printf '^F\t')" || true)"
    PR_CHANGED_FILES="$(printf '%s' "$PR_JSON" | jq -r '.changedFiles // ""' 2>/dev/null || echo "")"
    if ! [[ "$PR_CHANGED_FILES" =~ ^[0-9]+$ ]] || [[ "$RETRIEVED_FILE_COUNT" != "$PR_CHANGED_FILES" ]]; then
      info "変更ファイル一覧が PR の申告件数と一致しません（取得 $RETRIEVED_FILE_COUNT / 申告 ${PR_CHANGED_FILES:-不明}）。truncation の可能性があるため fail closed にします。"
      CHANGED_FILES_RAW=""
    fi
  fi

  # マーカーを外して resolver へ渡す（先頭は "F<TAB>" / "P<TAB>" の 2 文字）
  CHANGED_FILES=""
  if [[ -n "$CHANGED_FILES_RAW" ]]; then
    CHANGED_FILES="$(printf '%s\n' "$CHANGED_FILES_RAW" | sed "s/^[FP]$(printf '\t')//")"
  fi
  IMPACT_JSON=""
  if [[ -n "$CHANGED_FILES" ]] && command -v node >/dev/null 2>&1; then
    IMPACT_JSON="$(printf '%s\n' "$CHANGED_FILES" | node "$IMPACT_RESOLVER" --stdin 2>/dev/null || true)"
  fi
  IMPACT_DOCS_ONLY="false"
  IMPACT_INTEGRATION="true"
  if [[ -n "$IMPACT_JSON" ]]; then
    IMPACT_PRODUCT="$(printf '%s' "$IMPACT_JSON" | jq -r '.product' 2>/dev/null || echo true)"
    IMPACT_WEB="$(printf '%s' "$IMPACT_JSON" | jq -r '.web' 2>/dev/null || echo true)"
    IMPACT_DOCS_ONLY="$(printf '%s' "$IMPACT_JSON" | jq -r '.docsOnly' 2>/dev/null || echo false)"
    IMPACT_INTEGRATION="$(printf '%s' "$IMPACT_JSON" | jq -r '.integration' 2>/dev/null || echo true)"
  else
    info "影響判定を実行できませんでした。fail closed で両方の Vercel context を必須にします。"
  fi
  # Resolver の出力が想定外（jq のエラー文字列・null 等）なら fail closed に倒す。
  # 明示的な "false" だけが必須 context を外せる。
  if [[ "$IMPACT_PRODUCT" != "false" ]]; then IMPACT_PRODUCT="true"; fi
  if [[ "$IMPACT_WEB" != "false" ]]; then IMPACT_WEB="true"; fi
  # integration も同じ向き（明示的な "false" だけが Integration Tests の要求を外す）。
  # ci.yml の job `if:` と check.mjs の guard も同じ fail-closed 方向で揃えてある。
  if [[ "$IMPACT_INTEGRATION" != "false" ]]; then IMPACT_INTEGRATION="true"; fi
  # docsOnly は向きが逆（true が緩める側）なので、明示的な "true" だけを信じる。
  # 判定不能・想定外の出力は "false"（= CI check を必須にする厳格側）へ倒す。
  if [[ "$IMPACT_DOCS_ONLY" != "true" ]]; then IMPACT_DOCS_ONLY="false"; fi

  # 区切り文字は en dash（U+2013）。hyphen ではない。
  # **存在だけでなく success を要求する。** GitHub の StatusState には `EXPECTED`
  # （status の到着待ち）があり、これは上の is_failed にも is_pending にも該当しない。
  # 「context はあるが EXPECTED のまま」を通すと、build 未完了のまま merge できる。
  REQUIRED_CONTEXTS=()
  if [[ "$IMPACT_PRODUCT" == "true" ]]; then REQUIRED_CONTEXTS+=("Vercel – product"); fi
  if [[ "$IMPACT_WEB" == "true" ]]; then REQUIRED_CONTEXTS+=("Vercel – web"); fi

  if [[ ${#REQUIRED_CONTEXTS[@]} -eq 0 ]]; then
    info "app へ影響しない変更のため Vercel context は要求しません（docs / scripts / CI 設定等）。"
  else
    info "必須 Vercel context: ${REQUIRED_CONTEXTS[*]}"
  fi

  # 指定名の check が rollup 内でどの状態かを `success` / `not-success` / `missing`
  # のいずれかで返す。jq が失敗して出力が数値でない場合は厳格側（missing）へ倒す。
  context_state() {
    local name="$1" succeeded present
    succeeded="$(printf '%s' "$ROLLUP" | jq -r --arg name "$name" '
      map(select(
          ((.name // .context // "")) == $name
          and (
            ((.conclusion // "") | ascii_downcase | . == "success")
            or ((.state // "") | ascii_downcase | . == "success")
          )
        ))
      | length' 2>/dev/null || echo "")"
    if [[ "$succeeded" =~ ^[0-9]+$ ]] && [[ "$succeeded" != "0" ]]; then
      printf 'success'
      return
    fi
    present="$(printf '%s' "$ROLLUP" | jq -r --arg name "$name" '
      map(select(((.name // .context // "")) == $name)) | length' 2>/dev/null || echo "")"
    if [[ "$present" =~ ^[1-9][0-9]*$ ]]; then printf 'not-success'; else printf 'missing'; fi
  }

  for required in ${REQUIRED_CONTEXTS[@]+"${REQUIRED_CONTEXTS[@]}"}; do
    case "$(context_state "$required")" in
      success) ;;
      missing)
        error "必須 check「${required}」が 1 件も見つかりません。マージを中止します。"
        error "Vercel integration の接続、Ignored Build Step の有無、project 名を確認してください。"
        error "product / web の build はこの check でしか検証されません（Actions 側の build は撤去済み）。"
        exit 1
        ;;
      *)
        error "必須 check「${required}」が success ではありません。マージを中止します。"
        error "EXPECTED（status 到着待ち）のまま放置されている可能性があります。"
        error "product / web の build はこの check でしか検証されません（Actions 側の build は撤去済み）。"
        exit 1
        ;;
    esac
  done

  # ── Draft CI 廃止に伴う軽量層の実走要求（2026-08-26、#2415。2026-08-28、
  #    #2483 の CI ファイル統合でチェック体系が変わったため再改訂）─────────
  #
  # `.github/workflows/ci.yml` の Static / Unit は draft の間 skip される。
  # skip は conclusion: skipped の check run になるが、**skipped は上の
  # is_failed にも is_pending にも該当せず、is_decisive からも除外されている**。
  # つまり「draft 期の skipped だけが rollup にある」状態は、失敗 0 件・実行中
  # 0 件として通過する。**#2483 以前は success が 1 件以上という条件を docs
  # guard（draft guard を持たず常に走る独立 workflow）が満たしていたため、
  # 実質的にこの窓は塞がれていた。#2483 で docs-guard.yml は ci.yml の static
  # job（gitleaks + secrets:check + docs:check を含む）へ吸収され、static job
  # 自体が draft skip の対象になった**。つまり「Static Checks を docs-only で
  # 免除する」旧ルールをそのまま残すと、ready 化直後（ready_for_review で
  # 起きた新しい run の check がまだ登録されていない窓）に branch:finish を
  # 打った場合、gitleaks / secrets:check / docs:check が一度も実走しないまま
  # docs-only PR が merge されうる（fail-open。内製クロスレビュー
  # risk-reviewer 指摘、P1、PR #2484）。
  #
  # 塞ぐのは窓という 1 点ではなく「軽量層の実走を誰も検査していない」という class。
  # guard 条件の書き間違い・types からの ready_for_review 欠落・将来の別 workflow
  # への draft skip 追加でも同じ結果になるため、名前で success を要求する。
  #
  # **「🔍 Static Checks」は docs-only でも免除しない**（#2483 以降、static job
  # 自体が docs-only でも skip されず secret/docs 検査の唯一の実行経路のため）。
  # 「📦 Unit Tests」だけを docs-only で免除する（ci.yml の unit job は
  # `needs.impact.outputs.docs_only != 'true'` で実際に skip されるため、
  # ここを要求すると docs-only PR が永久に missing で止まる）。判定不能時は
  # IMPACT_DOCS_ONLY=false（＝両方要求する側）へ倒してある。
  # 「🧪 Integration Tests」（#2539 で test job から分離）は **integration affected な
  # PR でだけ**要求する。ci.yml 側は `integration != 'false'` で job ごと skip する
  # ため、無条件に要求すると skip される PR が永久に missing で止まる。判定不能時は
  # IMPACT_INTEGRATION=true（＝要求する側）へ倒してある。
  #
  # **docs-only と integration は独立に見る**（#2552）。impact.mjs は
  # `docs/engineering/data/db/rls-snapshot.md` のような「docs パスだが integration
  # 対象」を docsOnly=true / integration=true として返す。ここで docs-only を
  # 外側の条件にすると、rls-snapshot.md 単独の PR で RLS drift 検査を一度も
  # 走らせずに merge できてしまう。ci.yml の integration job も同じ向きに直してある
  # （どちらか片方だけ直すと gate と CI がずれるため、必ず両方同時に変更する）。
  REQUIRED_CI_CHECKS=("🔍 Static Checks")
  if [[ "$IMPACT_DOCS_ONLY" != "true" ]]; then
    REQUIRED_CI_CHECKS+=("📦 Unit Tests")
  else
    info "docs-only の変更のため Unit Tests の skip を許容します（Static Checks は引き続き要求します）。"
  fi
  if [[ "$IMPACT_INTEGRATION" != "false" ]]; then
    REQUIRED_CI_CHECKS+=("🧪 Integration Tests")
  else
    info "DB を触らない変更のため Integration Tests の skip を許容します。"
  fi

  for required in ${REQUIRED_CI_CHECKS[@]+"${REQUIRED_CI_CHECKS[@]}"}; do
    case "$(context_state "$required")" in
      success) ;;
      missing)
        error "必須 check「${required}」が 1 件も見つかりません。マージを中止します。"
        error "ready 化で ci.yml が再発火したか（types に ready_for_review が要る）を確認してください。"
        exit 1
        ;;
      *)
        error "必須 check「${required}」が success ではありません。マージを中止します。"
        error "draft 中の skipped のままになっている可能性があります。ready 化後の run の完了を待ってください。"
        exit 1
        ;;
    esac
  done

  # ── レビュー thread の解決を要求する ────────────────────────────────
  #
  # GitHub review の指摘 thread が未解決のまま merge できると、指摘の
  # 黙殺が構造的に可能になる。「解決」は 3 択のいずれか: ① fix を積んで resolve、
  # ② 反論・根拠を reply して resolve、③ 別 issue へ切り出し番号を reply して
  # resolve（`AGENTS.md §PR / git 運用` §レビュー）。
  #
  # thread の resolve 状態は GraphQL の reviewThreads にしか無い（REST には出ない）。
  # 取得に失敗した場合は「未確認のまま通す」ではなく停止に倒す（fail closed）。
  #
  # **`reviewThreads` は `pageInfo` の `hasNextPage` / `endCursor` で全ページを走査する。**
  # 旧実装は first: 100 を 1 回だけ引き、hasNextPage が true なら「全件確認できない」
  # として即停止していた。PR #1820（thread 101 件・未解決 0 件）が実際にこれで
  # 止まり、手動フォールバックを強いられた（issue #1831）。暴走防止の上限は件数
  # ではなくページ数 MAX_THREAD_PAGES に置く（first:100 × 20 = 最大 2000 件）。
  # この上限に達してもなお hasNextPage が true の場合だけ「全件確認できない」と
  # して停止する。
  step "レビュー thread の解決状態を確認"

  NAME_WITH_OWNER="$(gh api "repos/{owner}/{repo}" --jq '.full_name' 2>/dev/null || true)"

  MAX_THREAD_PAGES=20
  THREAD_FETCH_FAILED=false
  THREAD_PAGES_TRUNCATED=false
  THREAD_PAGE_JSONS=()

  if [[ "$NAME_WITH_OWNER" == */* ]]; then
    THREAD_OWNER="${NAME_WITH_OWNER%%/*}"
    THREAD_NAME="${NAME_WITH_OWNER##*/}"
    THREAD_CURSOR=""
    THREAD_PAGE=0

    while true; do
      THREAD_PAGE=$((THREAD_PAGE + 1))

      # 1 ページ目は cursor 変数を持たないクエリを使う（従来の shape を変えない）。
      # 2 ページ目以降は `after: $cursor` を持つ別クエリで続きを取る。
      if [[ -z "$THREAD_CURSOR" ]]; then
        THREAD_PAGE_JSON="$(gh api graphql \
          -f query='query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    isResolved
                    path
                    comments(first: 1) { nodes { author { login } } }
                  }
                }
              }
            }
          }' \
          -f owner="$THREAD_OWNER" \
          -f name="$THREAD_NAME" \
          -F number="$PR_NUMBER" 2>/dev/null || true)"
      else
        THREAD_PAGE_JSON="$(gh api graphql \
          -f query='query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $cursor) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    isResolved
                    path
                    comments(first: 1) { nodes { author { login } } }
                  }
                }
              }
            }
          }' \
          -f owner="$THREAD_OWNER" \
          -f name="$THREAD_NAME" \
          -F number="$PR_NUMBER" \
          -f cursor="$THREAD_CURSOR" 2>/dev/null || true)"
      fi

      # このページの hasNextPage / endCursor だけを取り出す。reviewThreads 自体が
      # null（pullRequest が見つからない等）なら select が空を返し、fail closed に倒す。
      THREAD_PAGE_INFO="$(printf '%s' "$THREAD_PAGE_JSON" | jq -r '
        .data.repository.pullRequest.reviewThreads
        | select(. != null)
        | "\(.pageInfo.hasNextPage) \(.pageInfo.endCursor // "")"' 2>/dev/null || true)"

      if [[ -z "$THREAD_PAGE_INFO" ]]; then
        THREAD_FETCH_FAILED=true
        break
      fi

      THREAD_HAS_NEXT="${THREAD_PAGE_INFO%% *}"
      THREAD_NEXT_CURSOR="${THREAD_PAGE_INFO#* }"

      if [[ "$THREAD_HAS_NEXT" != "true" && "$THREAD_HAS_NEXT" != "false" ]]; then
        # hasNextPage が欠落した等、想定外の形。停止はするが誤診断のメッセージを出さない。
        THREAD_FETCH_FAILED=true
        break
      fi

      THREAD_PAGE_JSONS+=("$THREAD_PAGE_JSON")

      if [[ "$THREAD_HAS_NEXT" != "true" ]]; then
        break
      fi

      if [[ "$THREAD_PAGE" -ge "$MAX_THREAD_PAGES" ]]; then
        THREAD_PAGES_TRUNCATED=true
        break
      fi

      THREAD_CURSOR="$THREAD_NEXT_CURSOR"
    done
  else
    THREAD_FETCH_FAILED=true
  fi

  if [[ "$THREAD_FETCH_FAILED" == true ]]; then
    error "レビュー thread の状態を取得できませんでした。マージを中止します（fail closed）。"
    error "gh の認証とネットワークを確認して再実行してください。"
    exit 1
  fi

  if [[ "$THREAD_PAGES_TRUNCATED" == true ]]; then
    error "レビュー thread が ${MAX_THREAD_PAGES} ページ（最大 $((MAX_THREAD_PAGES * 100)) 件）を超えており全件を確認できません。マージを中止します。"
    exit 1
  fi

  # 全ページの nodes を 1 つの配列へ結合する。個々のページの失敗は上の
  # THREAD_FETCH_FAILED で既に停止しているため、ここでの失敗は
  # 「配列を組み立てられない」想定外の形が混入した場合のみで、同じく fail closed にする。
  # 配列展開は bash 3.2 + set -u の空配列 unbound 対策で ${arr[@]+...} 形にする
  # （現経路では空で到達しないが、将来の経路追加で壊れないよう既存パターンに揃える）。
  ALL_THREADS_JSON="$(printf '%s\n' ${THREAD_PAGE_JSONS[@]+"${THREAD_PAGE_JSONS[@]}"} | jq -s '
    [.[] | .data.repository.pullRequest.reviewThreads.nodes[]]' 2>/dev/null || true)"

  if [[ -z "$ALL_THREADS_JSON" ]]; then
    error "レビュー thread の状態を取得できませんでした。マージを中止します（fail closed）。"
    error "gh の認証とネットワークを確認して再実行してください。"
    exit 1
  fi

  UNRESOLVED_THREADS="$(printf '%s' "$ALL_THREADS_JSON" | jq -r '[.[] | select(.isResolved | not)] | length')"

  if [[ "$UNRESOLVED_THREADS" != "0" ]]; then
    error "未解決のレビュー thread が $UNRESOLVED_THREADS 件あります。マージを中止します。"
    printf '%s' "$ALL_THREADS_JSON" | jq -r '
      .[]
      | select(.isResolved | not)
      | "    - \(.path // "(general)")（\(.comments.nodes[0].author.login // "unknown")）"' >&2 || true
    error "解決は 3 択: fix を積む / 反論を reply / issue 化して番号を reply。いずれも thread を resolve してから再実行してください。"
    exit 1
  fi

  info "未解決のレビュー thread はありません。"

  # ── 保護対象 path の判定（advisory レビューの目安、#2596） ──────────────
  #
  # Codex / 追加 reviewer marker の hard gate は #2596 で撤回した（merge の遮断は main の
  # ruleset が全経路で行う。#2640。AGENTS.md §レビュー）。保護対象 path の判定自体は削除せず、Main が
  # GitHub の @codex review でどこを重点的に読むかの目安として
  # 残す — ここでの判定結果は merge を止めない（情報表示のみ）。
  #
  # 判定は scripts/ci/protected-path-gate.mjs（正本）へ委譲する。入力は
  # Impact Resolver（§影響範囲を判定）で既に取得済みの $CHANGED_FILES を再利用し、
  # 追加の API 呼び出しはしない。$CHANGED_FILES が空（取得失敗）の場合は
  # Impact Resolver と同じ理由（判定不能 = 検証漏れの温床）で advisory 推奨側に倒す。
  step "保護対象 path を判定（advisory レビューの目安）"

  PROTECTED_GATE_SCRIPT="$SCRIPT_DIR/../ci/protected-path-gate.mjs"
  ADVISORY_REVIEW_RECOMMENDED="false"
  ADVISORY_REVIEW_REASONS=()

  # 「audit contract を変えたか」は unknown を既定にする。判定できない経路（files 一覧の
  # 取得失敗 / 3,000 件 truncation / node 不在）では contract 変更を否定できないため、
  # 下の trusted-head checkpoint は fail closed 側（status success を要求）へ倒す。
  AUDIT_CONTRACT_CHANGED="unknown"

  if [[ -z "$CHANGED_FILES" ]]; then
    ADVISORY_REVIEW_RECOMMENDED="true"
    ADVISORY_REVIEW_REASONS+=("changed files unavailable")
  elif ! command -v node >/dev/null 2>&1; then
    ADVISORY_REVIEW_RECOMMENDED="true"
    ADVISORY_REVIEW_REASONS+=("node unavailable")
  else
    PROTECTED_GATE_JSON="$(printf '%s\n' "$CHANGED_FILES" | node "$PROTECTED_GATE_SCRIPT" --stdin 2>/dev/null || true)"
    if [[ -z "$PROTECTED_GATE_JSON" ]]; then
      ADVISORY_REVIEW_RECOMMENDED="true"
      ADVISORY_REVIEW_REASONS+=("protected-path-gate.mjs failed")
    else
      # **`// "unknown"` を使わない。** jq の `//` は null と false の両方を falsy として
      # 右辺へ倒すため、`auditContract: false`（= contract を変えていない大多数の PR）が
      # `unknown` に化ける。boolean かどうかを明示的に見る。
      AUDIT_CONTRACT_CHANGED="$(printf '%s' "$PROTECTED_GATE_JSON" \
        | jq -r 'if (.auditContract | type) == "boolean" then (.auditContract | tostring) else "unknown" end' \
        2>/dev/null || echo unknown)"
      GATE_JSON_REQUIRED="$(printf '%s' "$PROTECTED_GATE_JSON" | jq -r '.required' 2>/dev/null || echo "")"
      case "$GATE_JSON_REQUIRED" in
        true)
          ADVISORY_REVIEW_RECOMMENDED="true"
          GATE_JSON_REASON="$(printf '%s' "$PROTECTED_GATE_JSON" | jq -r '.reason // "matched protected path"' 2>/dev/null || echo "matched protected path")"
          ADVISORY_REVIEW_REASONS+=("matched ${GATE_JSON_REASON}")
          ;;
        false)
          : # 該当なし。ADVISORY_REVIEW_RECOMMENDED は既定値 false のまま
          ;;
        *)
          ADVISORY_REVIEW_RECOMMENDED="true"
          ADVISORY_REVIEW_REASONS+=("protected-path-gate.mjs returned unparseable output")
          ;;
      esac
    fi
  fi

  if [[ "$ADVISORY_REVIEW_RECOMMENDED" == "true" ]]; then
    ADVISORY_REVIEW_REASON_JOINED="$(IFS=', '; echo "${ADVISORY_REVIEW_REASONS[*]}")"
    echo "GitHub @codex review focus recommended (${ADVISORY_REVIEW_REASON_JOINED}) — merge は止めません" >&2
  else
    echo "GitHub @codex review focus: 保護対象 path に該当なし" >&2
  fi

  # ── audit contract 変更 PR は trusted dispatch の status を必ず要求する（#2571）──
  #
  # `production-config-audit.yml` の `pull_request_target` は contract 4 path の `paths`
  # filter を持つ（Actions の削減）。**workflow が起動したかどうかに checkpoint を委ねない。**
  # 起動しない条件は `paths` の意味論だけでなく次のクラスを含み、いずれも「PR code に
  # contract 変更を自己検証させない」という設計を静かに無効化する:
  #
  #   - Actions を一時 Disable している間（incident 対応で実際に行う運用がある）
  #   - base branch の workflow 定義が壊れている / 消えている（`pull_request_target` は
  #     **base 側の定義**で評価されるため、PR 側を直しても効かない）
  #   - `paths` の書き間違いで対象を取りこぼす
  #   - GitHub の `paths` 仕様（changed files が 3,000 件を超え、一致するファイルが
  #     先頭 3,000 件に無いと起動しない）
  #
  # そこで changed-files 由来の判定（`protected-path-gate.mjs` の `auditContract`）で
  # commit status `Production Config Audit` の success（= trusted dispatch 実行済み）を
  # 要求する。**判定できなかった場合（`unknown`）も要求する** —— contract 変更を否定
  # できない以上、通す理由が無い（fail closed。Codex / architecture-guard の両系統から
  # 同じ指摘。#2586）。`unknown` になるのは変更ファイル一覧そのものを取得できなかった
  # 時（API 失敗 / 3,000 件 truncation / node 不在）だけで、その PR は同じ理由で
  # `ADVISORY_REVIEW_RECOMMENDED` も立っている。
  #
  # status の照合は上の免除ロジックと同じ述語（`$JQ_GATE_DEFS` の `trusted_audit_cleared`）
  # を使う。コピーすると、context 名や条件を片方だけ変えた時に **checkpoint 側だけが
  # 無言で無効化される**（免除側だけズレても「うるさいが安全」側に倒れるので非対称）。
  if [[ "$AUDIT_CONTRACT_CHANGED" != "false" ]]; then
    AUDIT_STATUS_OK="$(printf '%s' "$ROLLUP" | jq -r "$JQ_GATE_DEFS"'
      if trusted_audit_cleared then "true" else "false" end' 2>/dev/null || echo "")"
    if [[ "$AUDIT_STATUS_OK" != "true" ]]; then
      if [[ "$AUDIT_CONTRACT_CHANGED" == "unknown" ]]; then
        error "変更ファイル一覧を取得できず、audit contract を変更したか判定できませんでした。"
        error "contract 変更を否定できないため、trusted dispatch を要求します（fail closed）。"
      else
        error "この PR は audit contract（audit script / production-build-gate / workflow 自身）を変更しています。"
      fi
      error "commit status「Production Config Audit」が現 HEAD で success になっていません。"
      error "PR code に contract 変更を自己検証させないため、trusted dispatch が必要です:"
      error "  gh workflow run production-config-audit.yml --ref $BRANCH"
      error "完了後に再実行してください（status は SHA ごとなので push のたびに要ります）。"
      exit 1
    fi
    info "audit contract の trusted dispatch を確認しました（status「Production Config Audit」= success）。"
  fi


  # マージは REST を直叩きする。`gh pr merge` は「削除対象 branch が current」だと
  # **実行元の worktree を main へ切り替えてから** ローカル branch を削除するため、
  # 並行セッション環境では実行元の足元と main checkout を壊す（#1771 の症状①）。
  # gh api なら構造的にローカル git へ触れない。
  #
  # sha を渡して check gate 通過後の push を弾く（`gh pr merge --match-head-commit` 相当）。
  # 渡さないと、gate を見てからマージするまでの間に積まれた未検証 commit ごとマージしうる。
  # dry-run の表示と実行を同じ配列から作る。手書きで二重に持つと、実行側から
  # `sha=` が落ちても dry-run 側が残っている限り test が pass してしまう。
  MERGE_ARGS=(-X PUT "repos/{owner}/{repo}/pulls/$PR_NUMBER/merge"
    -f merge_method=merge -f "sha=$HEAD_SHA")
  DELETE_REF_ARGS=(-X DELETE "repos/{owner}/{repo}/git/refs/heads/$BRANCH")

  if [[ "$DRY_RUN" == true ]]; then
    echo "   [dry-run] gh api ${MERGE_ARGS[*]}" >&2
    echo "   [dry-run] gh api ${DELETE_REF_ARGS[*]}" >&2
  else
    if ! gh api "${MERGE_ARGS[@]}" >/dev/null; then
      error "PR #$PR_NUMBER のマージに失敗しました。"
      error "gh pr view $PR_NUMBER で状態を確認してください（head が更新された可能性があります）。"
      exit 1
    fi
    info "マージしました。リモート branch を削除します。"
    # repo 設定は deleteBranchOnMerge: true だが、設定変更で掃除が静かに止まらないよう
    # 明示的にも削除する。既に消えていれば 422 になるので失敗は無視してよい
    # （残存した場合は step 8 が fetch --prune 後に検証する）。
    gh api "${DELETE_REF_ARGS[@]}" >/dev/null 2>&1 || true
  fi
else
  info "PR は既にクローズ済みのためマージ手順はスキップします。"
fi

# ── 3. 該当 branch の worktree を特定 ────────────────────────────────
step "worktree を特定"

# `git worktree list --porcelain` を解析し branch が一致する worktree path を得る
WORKTREE_PATH="$(git worktree list --porcelain | awk -v br="refs/heads/$BRANCH" '
  /^worktree / { path = substr($0, 10) }
  /^branch / && $2 == br { print path; exit }
')"

if [[ -n "$WORKTREE_PATH" ]]; then
  info "worktree: $WORKTREE_PATH"
else
  info "この branch に紐づく worktree はありません。"
fi

# ── 4. worktree の dirty 確認 ───────────────────────────────────────
if [[ -n "$WORKTREE_PATH" ]]; then
  step "worktree の未コミット差分を確認"

  DIRTY="$(git -C "$WORKTREE_PATH" status --porcelain 2>/dev/null || true)"

  if [[ -n "$DIRTY" ]]; then
    # tracked ファイルの差分があるかを判定する。
    # gitignore された生成物（--porcelain には出ない）ではなく、
    # tracked の変更や未追跡ファイルが残っている場合はユーザー作業として扱う。
    error "worktree に未コミットの差分があります。掃除を中止します。"
    error "内容を確認してください: git -C \"$WORKTREE_PATH\" status"
    printf '%s\n' "$DIRTY" | sed 's/^/    /' >&2
    exit 1
  fi

  info "差分なし。削除して問題ありません。"
fi

# ── 5. worktree 削除 ────────────────────────────────────────────────
if [[ -n "$WORKTREE_PATH" ]]; then
  step "worktree を削除"
  # gitignore された生成物（.next/ 等）だけが残って remove が拒否される場合に備え、
  # dirty 確認（step 4）を通過している前提で --force を付ける。
  run git worktree remove --force "$WORKTREE_PATH"
fi

# 孤児化した worktree 管理情報をここで掃除する（step 6 より前に行う）。
# 次の step は worktree list から main の checkout 先を探すため、ディレクトリが
# 消えた worktree の entry が残っていると、存在しない path へ pull を試みて
# main を更新できなくなる。
run git -C "$MAIN_ROOT" worktree prune

# ── 6. main を最新化（branch 削除より先に行う） ─────────────────────
# マージは REST 経由なので、この時点ではローカル main にマージコミットが無い。
# 先に main を最新化しておくと、マージコミットの第2親 = branch 先端がローカル main
# から辿れるようになり、続く step 7 の判定が「マージ済み」を正しく返す。
#
# **checkout は使わない。** main checkout が別セッションの branch にいる場合、
# `checkout main` はそれを奪って切り替えてしまう（#1771 の症状②）。
# 代わりに main を checkout 中の worktree を探し、その場で ff pull する。
# どこも checkout していなければローカル ref だけを fast-forward する。
step "main を最新化"

# fetch も止めない。ここで落ちると worktree を消した直後の中途半端な状態で終わる。
run git -C "$MAIN_ROOT" fetch --prune origin ||
  info "origin の fetch に失敗しました（続行します）。"

# main を checkout している worktree を探す（step 3 と同じ porcelain 解析）
MAIN_WORKTREE="$(git -C "$MAIN_ROOT" worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10) }
  /^branch / && $2 == "refs/heads/main" { print path; exit }
')"

# 更新に失敗しても止めない。ここは掃除の前準備であってマージゲートではなく、
# main が古いままなら step 7 の ancestor 判定が偽になって fail-closed に停止する。
if [[ -n "$MAIN_WORKTREE" ]]; then
  info "main は $MAIN_WORKTREE が checkout 中です。その worktree で fast-forward します。"
  run git -C "$MAIN_WORKTREE" pull --ff-only origin main ||
    info "main の pull に失敗しました（続行します）。"
else
  # checkout 中の branch には fetch できないため、この分岐でのみ ref 直更新が使える。
  # force refspec（+main:main）は使わない。diverge した異常系を握り潰さないため。
  info "main はどの worktree でも checkout されていません。ローカル ref のみ更新します。"
  run git -C "$MAIN_ROOT" fetch origin main:main ||
    info "main ref の更新に失敗しました（続行します）。"
fi

# ── 7. ローカル branch を削除 ───────────────────────────────────────
step "ローカル branch を削除"

if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  # -d は merge 済みなら成功する。まずこれを試し、通常系の挙動は変えない。
  if [[ "$DRY_RUN" == true ]]; then
    echo "   [dry-run] git -C \"$MAIN_ROOT\" branch -d ${BRANCH}（失敗時は main への到達を確認）" >&2
  elif ! git -C "$MAIN_ROOT" branch -d "$BRANCH" 2>"$BRANCH_ERR_FILE"; then
    # `branch -d` は **HEAD に対して** マージ済みかを見る。main checkout が別 branch に
    # いると、main へ完全にマージ済みの branch でも not fully merged で拒否される
    # （#1771 の症状③）。main を基準に直接判定し直す。
    #
    # ref は完全修飾する（`main` だけだと同名 tag が branch より先に解決される）。
    # ローカル main と origin/main の両方を見るのは、step 6 の main 更新が非致命だから。
    # origin/main は fetch 済みで、どちらから到達できてもマージ済みの証明になる。
    if git -C "$MAIN_ROOT" merge-base --is-ancestor "refs/heads/$BRANCH" refs/heads/main 2>/dev/null ||
      git -C "$MAIN_ROOT" merge-base --is-ancestor "refs/heads/$BRANCH" refs/remotes/origin/main 2>/dev/null; then
      # branch の全 commit が main から辿れる = 「main へ完全にマージ済み」の直接証明。
      # -d の HEAD 基準ヒューリスティックより強い条件を確認済みなので、この -D は
      # 未マージ branch の強制削除ではなく -d の偽陰性の訂正にあたる。
      info "HEAD 基準では未マージ扱いですが、main への到達を確認しました。削除します。"
      git -C "$MAIN_ROOT" branch -D "$BRANCH"
    else
      cat "$BRANCH_ERR_FILE" >&2 || true
      error "branch '$BRANCH' は main に到達しておらず削除できません。"
      error "ローカル main が origin/main より古い可能性があります。step 6 の出力を確認してください。"
      error "本当にマージ済みかを確認してから対処してください（-D 強制は避ける）。"
      exit 1
    fi
  fi
else
  info "ローカル branch '$BRANCH' は既にありません。"
fi

# ── 8. リモート branch の消滅を確認 ─────────────────────────────────
# step 6 の fetch --prune で origin/<branch> は消えているはず。
# 万一 --delete-branch が効かず残っていれば明示的に削除する。
step "リモート branch を確認"

REMOTE_BRANCH_REMAINS=false

if [[ "$DRY_RUN" == false ]]; then
  if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    info "リモートに origin/$BRANCH が残っています。削除します。"
    git -C "$MAIN_ROOT" push origin --delete "$BRANCH" ||
      error "リモート branch の削除に失敗しました。"
  fi

  # 削除コマンドの成否ではなく、実際に消えたかをリモートへ問い合わせて確認する
  # （完了定義④）。確認自体に失敗した場合は「未確認」ではなく「残存」に倒す。
  if REMOTE_HEADS="$(git -C "$MAIN_ROOT" ls-remote --heads origin "$BRANCH" 2>/dev/null)"; then
    if [[ -n "$REMOTE_HEADS" ]]; then
      REMOTE_BRANCH_REMAINS=true
    else
      info "リモート branch は消滅済みです。"
    fi
  else
    error "リモート branch の消滅を確認できませんでした。"
    REMOTE_BRANCH_REMAINS=true
  fi
fi

# ── 9. サマリー ─────────────────────────────────────────────────────
step "完了"

if [[ "$DRY_RUN" == true ]]; then
  info "dry-run のため実際の変更は行っていません。"
else
  # 完了していない項目があるなら ✅ を出さない。この出力は AI / 人間が
  # 「作業終了」の判定に使うため、未達を伏せると積み残しがそのまま流れる。
  if [[ "$REMOTE_BRANCH_REMAINS" == true ]]; then
    error "リモート branch origin/$BRANCH が残っています（完了定義④が未達）。"
    error "手動で削除してください: git -C \"$MAIN_ROOT\" push origin --delete $BRANCH"
    exit 1
  fi

  echo "✅ PR #$PR_NUMBER を片付けました:" >&2
  echo "   - branch: ${BRANCH}（ローカル / リモートとも削除）" >&2
  [[ -n "$WORKTREE_PATH" ]] && echo "   - worktree: ${WORKTREE_PATH}（削除）" >&2

  # 完了定義⑤: ローカル main ref が origin/main と一致していること。
  # main checkout がどの branch にいるかは問わない（別セッションの作業を尊重する）。
  # ref は完全修飾する（同名 tag があると `main` は branch より先にそちらを指す）。
  LOCAL_MAIN="$(git -C "$MAIN_ROOT" rev-parse --verify --quiet refs/heads/main || echo unknown)"
  REMOTE_MAIN="$(git -C "$MAIN_ROOT" rev-parse --verify --quiet refs/remotes/origin/main || echo unknown)"
  echo "   - main HEAD: ${LOCAL_MAIN:0:7}" >&2

  if [[ "$LOCAL_MAIN" == "$REMOTE_MAIN" && "$LOCAL_MAIN" != "unknown" ]]; then
    echo "   - ローカル main は origin/main と一致しています" >&2
  else
    info "ローカル main が origin/main と一致していません（local: ${LOCAL_MAIN:0:7} / remote: ${REMOTE_MAIN:0:7}）。"
    if [[ -n "$MAIN_WORKTREE" ]]; then
      # main が checkout 中の branch には fetch できないため、pull を案内する。
      info "取り込んでください: git -C \"$MAIN_WORKTREE\" pull --ff-only origin main"
    else
      info "取り込んでください: git -C \"$MAIN_ROOT\" fetch origin main:main"
    fi
  fi
fi

echo "" >&2
echo "残っている worktree:" >&2
git -C "$MAIN_ROOT" worktree list >&2
