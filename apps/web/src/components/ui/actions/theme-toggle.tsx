import { useTranslations } from 'next-intl';
import { ThemeSelect } from './theme-select';

export function ThemeToggle() {
  const t = useTranslations('common');
  return (
    <ThemeSelect
      label={t('aria.changeTheme')}
      names={{ light: t('theme.light'), dark: t('theme.dark'), system: t('theme.system') }}
    />
  );
}
