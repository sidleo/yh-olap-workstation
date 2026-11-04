# Third-party notices

The client bundle (`dist/client.js`) includes the following MIT-licensed libraries:

- CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`,
  `@codemirror/commands`, `@codemirror/search`, `@codemirror/autocomplete`,
  `@codemirror/lint`, `@codemirror/lang-sql`, `codemirror` meta package) — MIT,
  https://github.com/codemirror
- `@lezer/highlight`, `@lezer/common`, `@lezer/lr`, `@lezer/sql` — MIT, https://github.com/lezer-parser
- `style-mod`, `w3c-keyname`, `crelt` — MIT (CodeMirror dependencies)

React and React DOM are **not** bundled; they are provided by the DSH browser runtime.
The plugin's own code is MIT (see repository LICENSE, if present).
