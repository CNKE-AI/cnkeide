/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./renderer/src/**/*.{js,ts,jsx,tsx}', './renderer/index.html'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        /* iOS 语义色：用于状态提示，替代散落的 amber/sky 硬编码 */
        glass: 'var(--glass-bg)',
        'glass-strong': 'var(--glass-bg-strong)',
        hairline: 'var(--glass-border)',
      },
      /*
       * 圆角统一上抬一档：iOS 观感的关键之一是"同样的控件，圆角更大"。
       * 这里集中改，全站 tailwind 类自动跟随，避免逐个组件调数值。
       */
      borderRadius: {
        sm: '7px',
        DEFAULT: '10px',
        md: '10px',
        lg: '13px',
        xl: '16px',
        '2xl': '20px',
        '3xl': '26px',
        panel: 'var(--radius-panel)',
        control: 'var(--radius-control)',
        chip: 'var(--radius-chip)',
        pill: '999px',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'SF Pro Display',
          'Segoe UI Variable Text',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei UI',
          'Microsoft YaHei',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: ['SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        /* 小字最小 11px：低于这个字号在高分屏上已经不可读 */
        '2xs': ['11px', { lineHeight: '1.5' }],
        xs: ['12px', { lineHeight: '1.5' }],
        sm: ['13px', { lineHeight: '1.55' }],
        base: ['14px', { lineHeight: '1.6' }],
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        float: 'var(--shadow-float)',
        modal: 'var(--shadow-modal)',
        focus: 'var(--shadow-focus)',
        'inner-hair': 'inset 0 1px 0 var(--glass-highlight)',
      },
      backdropBlur: {
        glass: '24px',
        heavy: '32px',
      },
      transitionTimingFunction: {
        ios: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      transitionDuration: {
        150: '150ms',
        200: '200ms',
        260: '260ms',
        340: '340ms',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.975)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        'pop-in': 'pop-in 220ms cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [],
};
