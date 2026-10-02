import design from '@web/components/content/ContentDesign.module.css';
import type { NavigationSection } from '@web/shell/navigation';
import { getTranslations } from 'next-intl/server';
import { GuideNavigation } from './GuideNavigation';

/** モバイルでも章を選んで読み進められる Docs ナビゲーション。 */
export async function DocsMobileNavigation({ navigation }: { navigation: NavigationSection[] }) {
  const t = await getTranslations('docs');
  return (
    <div className={design.mobileNavigation}>
      <GuideNavigation navigation={navigation} label={t('browse')} />
    </div>
  );
}
