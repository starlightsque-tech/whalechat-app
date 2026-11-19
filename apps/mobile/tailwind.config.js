/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
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
    },
  },
  plugins: [],
};
