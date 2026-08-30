import globals from 'globals';

export default [
  { ignores: ['dist/**', 'optimized/**', 'node_modules/**'] },
  {
    files: ['lib/**/*.js', 'content/**/*.js', 'extension/**/*.js', 'popup/**/*.js', 'audit/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, chrome: 'readonly' }
    },
    rules: { 'no-undef': 'error' }
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.js', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, chrome: 'readonly' }
    },
    rules: { 'no-undef': 'error' }
  }
];
