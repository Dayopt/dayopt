---
status: current
last_verified: 2026-09-21
---

# Lab: 通信を壊す（届かない / 返事だけ失われる）

Plan の保存で通信が壊れた時、画面・DB・再試行に何が起きるかを確かめる。**同じ「通信が切れた」でも、どこで切れたかで結果が逆になる**ことを見る。

## 目的

- 依頼が**サーバーに届く前**に切れた時と、**DB で確定した後に返事だけ**失われた時を比べる
- 楽観的更新の巻き戻しと、取り直し（`onSettled`）の効き方を見る

## 予想を書く（先に）

1. 届く前に切れた時、画面の Plan はどうなるか。DB には入るか
2. 返事だけ失われた時、画面の Plan はどうなるか。DB には入るか
3. どちらの場合も同じトーストが出るとしたら、利用者は何をするか

## 準備

[1 つの依頼を追う](trace-request.md) と同じ（local で product を起動してサインイン、DevTools を開く）。

## 手順

### A. 届く前に切る

1. DevTools → Network → 依頼を右クリック →「Block request URL」、または Network request blocking に `planCommands.create` を足す
2. サイドバーのアクティビティを押す
3. 画面とトーストを見て、DB を見る（[trace-request](trace-request.md) の psql）
4. blocking を外す

### B. 返事だけ失う

DevTools では作りにくいので、Console に次を貼る（このタブだけに効く。再読み込みで消える）。

```js
const orig = window.fetch;
window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('/api/trpc') && url.includes('planCommands.create')) {
    await orig.apply(this, arguments); // サーバーには届き、DB で確定する
    throw new TypeError('Failed to fetch'); // 返事だけ失われたことにする
  }
  return orig.apply(this, arguments);
};
```

1. サイドバーのアクティビティを押し、**押した直後から 1 秒ほど**画面を見る
2. DB を見る
3. ページを再読み込みして元の fetch に戻す

## 観察する 5 点

| 観点     | A: 届く前 | B: 返事だけ失う |
| -------- | --------- | --------------- |
| 画面     |           |                 |
| DB       |           |                 |
| 再試行   |           |                 |
| 痕跡     |           |                 |
| 二重登録 |           |                 |

## 実測結果（2026-09-21、local）

<details>
<summary>開く</summary>

**A: 届く前に切れた**

- 画面: 薄い Plan が一瞬出て消え、「保存できませんでした。入力内容は保持されています。もう一度お試しください」
- DB: 変化なし
- 再試行: 自動ではしない（`retry: false`）。取り直し（6 つの query を 1 本で）だけは走った

**B: 返事だけ失われた**

- 画面の時系列: 押して 30ms で一時 ID（`temp-`）の Plan が出る → 150ms で巻き戻って消える → **400ms で本物の Plan が再び現れる**（取り直しで、DB に入っていた行を読んだ）
- トースト: A と**同じ**「保存できませんでした。…もう一度お試しください」。600ms の時点で、このトーストと、保存済みの Plan が**同時に**画面にあった
- DB: 行が入っている
- 二重登録: トーストに従ってもう一度押すと、同じ内容の Plan が 2 つになる。これが UI からの保存で二重作成が起きる唯一の筋。MCP からの作成は `operationId` で送り直しても 2 つ目を作らない（[経路: MCP](../journeys/mcp.md)）

</details>

## 元に戻す

- Network request blocking を外す、ページを再読み込みする（B の fetch の差し替えが消える）
- 作られた Plan を削除する

## 考える

- B で「保存できませんでした」と出すのは正しいか。サーバーでは保存できている。取り直しの結果を見てから文言を決める、冪等の鍵を持たせる、などの選択肢と、それぞれの代償は何か
- 変えるなら、どこに響くか → [12. 変更](../12-change.md) の逆引きで `useTimeblockWriteMutations.ts` を探す

## 関連

- [経路: Plan を保存](../journeys/save-plan.md) の「⚡ 通信が途中で切れる」
- [2. UI → DB](../02-ui-to-db.md)、[7. 障害](../07-failures.md)
