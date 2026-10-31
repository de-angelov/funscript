# FunScript for VS Code

The extension provides language support and formatting for `.fun` and `.funx`
files through the FunScript language server. To format on save, add this to your
VS Code `settings.json`:

```json
{
  "[funscript]": {
    "editor.formatOnSave": true
  },
  "[funscriptx]": {
    "editor.formatOnSave": true
  }
}
```

The extension uses the `funscript` executable by default. Set
`funscript.serverPath` if it is installed at a different path.
