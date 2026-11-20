/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        abyss: '#04101a',
        deep: '#071a27',
        panel: '#0b2233',
        tide: '#123249',
        foam: '#8fd9c8',
        mint: '#34d3a6',
        coral: '#ff6b6b',
        gold: '#f5c451',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 20px 50px -30px rgba(0,0,0,0.9)',
      },
    },
  },
  plugins: [],
};
