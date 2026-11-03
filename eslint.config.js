import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * Layering: ui -> state -> backend -> domain, and i18n/domain stay leaf modules.
 * The frontend never talks to the game directly; only `src/backend` may reach the Rust side.
 */
const layers = ['domain', 'i18n', 'backend', 'state', 'ui', 'app']
const allowed = {
  domain: [],
  i18n: [],
  backend: ['domain'],
  state: ['domain', 'backend'],
  ui: ['domain', 'state', 'i18n', 'theme'],
  app: ['domain', 'backend', 'state', 'ui', 'i18n', 'theme'],
}
const forbidden = (layer) => layers.filter((l) => l !== layer && !allowed[layer].includes(l))

const boundaryConfigs = layers
  .filter((layer) => forbidden(layer).length > 0)
  .map((layer) => ({
    files: [`src/${layer}/**/*.{ts,tsx}`],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(@/|(\.\./)+)(${forbidden(layer).join('|')})(/|$)`,
              message: `The "${layer}" layer must not import from this layer.`,
            },
          ],
        },
      ],
    },
  }))

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src-tauri/target', 'src-tauri/gen'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.js', 'vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  ...boundaryConfigs,
)
