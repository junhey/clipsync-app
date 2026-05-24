# CI workflow template

`ci.yml.template` is the GitHub Actions workflow ClipSync uses for cross-platform builds (macOS / Windows / Ubuntu).

It was kept here instead of `.github/workflows/` because the OAuth token used to push the initial commit didn't have the `workflow` scope.

## To enable CI

```bash
mkdir -p .github/workflows
cp docs/ci-template/ci.yml.template .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: enable cross-platform build workflow"
git push
```

You may need a PAT with `workflow` scope for that one push. Subsequent commits don't need it.
