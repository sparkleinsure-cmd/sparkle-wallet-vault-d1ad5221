export type ThemePreference = "system" | "dark" | "light";

const THEME_KEY = "sparkle_theme_preference";

export function getThemePreference(): ThemePreference {
  const preference = localStorage.getItem(THEME_KEY);
  return preference === "dark" || preference === "light" ? preference : "system";
}

export function applyTheme(preference: ThemePreference) {
  const isDark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
}

export function setThemePreference(preference: ThemePreference) {
  localStorage.setItem(THEME_KEY, preference);
  applyTheme(preference);
}
