import type { AiPptArtDirection } from './pptDesign';

export interface ArtPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
}

/** 生成可直接嵌入 HTML 的主题化矢量场景，不依赖外部图片或模板。 */
export function renderArtScene(direction: AiPptArtDirection, palette: ArtPalette, variant = 0): string {
  const scene = direction === 'culture'
    ? cultureScene(palette, variant)
    : direction === 'technology'
      ? technologyScene(palette, variant)
      : direction === 'healthcare'
        ? healthcareScene(palette, variant)
        : direction === 'business'
          ? businessScene(palette, variant)
          : educationScene(palette, variant);
  return `<svg class="art-scene" viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${scene}</svg>`;
}

function educationScene(p: ArtPalette, variant: number): string {
  const shift = (variant % 3) * 18;
  return `
    <rect width="640" height="400" fill="${p.background}"/>
    <ellipse cx="${430 + shift}" cy="250" rx="180" ry="78" fill="${p.accent}" opacity=".16"/>
    <path d="M70 300 C150 230 230 330 320 250 C410 170 500 280 610 190" fill="none" stroke="${p.primary}" stroke-width="8" opacity=".18"/>
    <rect x="92" y="126" width="150" height="108" rx="18" fill="#fff" stroke="${p.primary}" stroke-width="4"/>
    <path d="M112 154 h110 M112 176 h82 M112 198 h96" stroke="${p.secondary}" stroke-width="7" stroke-linecap="round"/>
    <circle cx="390" cy="150" r="48" fill="${p.primary}"/>
    <circle cx="374" cy="142" r="5" fill="#fff"/><circle cx="406" cy="142" r="5" fill="#fff"/>
    <path d="M374 166 q16 14 32 0" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
    <rect x="430" y="188" width="92" height="78" rx="16" fill="${p.secondary}"/>
    <path d="M452 214 h48 M452 234 h34" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
  `;
}

function cultureScene(p: ArtPalette, variant: number): string {
  const shift = (variant % 3) * 24;
  return `
    <rect width="640" height="400" fill="${p.background}"/>
    <path d="M0 286 C90 230 150 330 250 270 C350 210 430 330 640 230 V400 H0 Z" fill="${p.primary}" opacity=".12"/>
    <path d="M40 250 C120 180 180 250 260 180 C340 110 430 230 530 150" fill="none" stroke="${p.secondary}" stroke-width="5" opacity=".45"/>
    <circle cx="${470 - shift}" cy="118" r="34" fill="${p.accent}" opacity=".75"/>
    <rect x="126" y="150" width="126" height="92" rx="8" fill="#fff" opacity=".88"/>
    <path d="M146 176 h86 M146 198 h62" stroke="${p.primary}" stroke-width="6" stroke-linecap="round"/>
    <path d="M330 122 l34 78 h-68 z" fill="${p.secondary}" opacity=".8"/>
  `;
}

function technologyScene(p: ArtPalette, variant: number): string {
  const y = 150 + (variant % 2) * 12;
  return `
    <rect width="640" height="400" fill="${p.background}"/>
    <circle cx="500" cy="150" r="120" fill="${p.primary}" opacity=".08"/>
    <rect x="78" y="${y}" width="190" height="122" rx="22" fill="${p.primary}"/>
    <rect x="98" y="${y + 20}" width="150" height="72" rx="12" fill="#fff" opacity=".92"/>
    <circle cx="360" cy="176" r="46" fill="${p.accent}"/>
    <rect x="430" y="134" width="118" height="86" rx="18" fill="${p.secondary}"/>
    <path d="M454 164 h70 M454 186 h48" stroke="#fff" stroke-width="7" stroke-linecap="round"/>
  `;
}

function healthcareScene(p: ArtPalette, variant: number): string {
  const x = 390 + (variant % 3) * 16;
  return `
    <rect width="640" height="400" fill="${p.background}"/>
    <ellipse cx="470" cy="230" rx="160" ry="70" fill="${p.accent}" opacity=".15"/>
    <rect x="96" y="128" width="150" height="112" rx="24" fill="#fff" stroke="${p.primary}" stroke-width="4"/>
    <path d="M154 160 v48 M130 184 h48" stroke="${p.accent}" stroke-width="12" stroke-linecap="round"/>
    <circle cx="${x}" cy="150" r="42" fill="${p.secondary}"/>
    <rect x="438" y="188" width="104" height="72" rx="18" fill="${p.primary}" opacity=".85"/>
  `;
}

function businessScene(p: ArtPalette, variant: number): string {
  const h = 78 + (variant % 3) * 18;
  return `
    <rect width="640" height="400" fill="${p.background}"/>
    <rect x="78" y="${250 - h}" width="58" height="${h}" rx="10" fill="${p.primary}"/>
    <rect x="154" y="150" width="58" height="126" rx="10" fill="${p.secondary}"/>
    <rect x="230" y="112" width="58" height="164" rx="10" fill="${p.accent}"/>
    <circle cx="430" cy="150" r="72" fill="${p.primary}" opacity=".1"/>
    <path d="M378 188 l36-46 28 24 48-62" fill="none" stroke="${p.primary}" stroke-width="8" stroke-linecap="round"/>
  `;
}
