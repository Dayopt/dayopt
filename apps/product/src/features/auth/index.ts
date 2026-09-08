/**
 * Auth Feature - Public API
 *
 * docs: docs/product/specs/auth.md
 *
 * この barrel export は外部から参照される公開インターフェースを定義する。
 * 内部モジュールへの直接参照（deep import）は避け、ここからのみ import すること。
 */

// --- Components ---
export { AuthLayout } from './components/AuthLayout';
export { LoginForm } from './components/LoginForm';
export { MFAVerifyForm } from './components/MFAVerifyForm';
export { PasswordResetForm } from './components/PasswordResetForm';
export { ResetPasswordForm } from './components/ResetPasswordForm';
export { SessionMonitorProvider } from './components/SessionMonitorProvider';
/** @public Storybook security pattern uses the feature-level component contract. */
export { SessionTimeoutDialog } from './components/SessionTimeoutDialog';
export { SignupForm } from './components/SignupForm';
// --- Domain ---
/** @public ログイン手段の判定。settings がパスワード前提の UI を出し分けるために使う */
export { hasPasswordIdentity, hasVerifiedMfaFactor } from './domain';
// --- Stores ---
export { AuthStoreInitializer } from './stores/AuthStoreInitializer';
export { waitForResolvedUserId } from './stores/resolve-user-id';
export { useAuthStore } from './stores/useAuthStore';

// ここにないものはfeature内部専用
