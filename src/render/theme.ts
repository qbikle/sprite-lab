/** Cached CSS token colors for the rAF draw loop — getComputedStyle is costly,
 *  so resolve once and re-read only after the viewport sees 'theme:changed'. */

export interface ThemeColors {
  accent: string;
  border: string;
  text: string;
}

let cache: ThemeColors | null = null;

export function themeColors(): ThemeColors {
  if (!cache) {
    const styles = getComputedStyle(document.documentElement);
    cache = {
      accent: styles.getPropertyValue('--accent').trim() || '#ffb454',
      border: styles.getPropertyValue('--border').trim() || '#000',
      text: styles.getPropertyValue('--text').trim() || '#888',
    };
  }
  return cache;
}

export function invalidateThemeColors(): void {
  cache = null;
}
