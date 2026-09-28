import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Both Next apps and the fallback script run from apps/<app>. Keep these files
// in outputFileTracingIncludes so the same fonts are available after deployment.
export async function loadOgFonts() {
  const directory = path.join(process.cwd(), '../../packages/assets/fonts');
  const [latin, japanese] = await Promise.all([
    readFile(path.join(directory, 'SourceSans3-Semibold.ttf')),
    readFile(path.join(directory, 'NotoSansJP-Medium.ttf')),
  ]);

  return [
    { name: 'Dayopt OG Latin', data: latin, weight: 600 as const, style: 'normal' as const },
    { name: 'Dayopt OG Japanese', data: japanese, weight: 600 as const, style: 'normal' as const },
  ];
}
