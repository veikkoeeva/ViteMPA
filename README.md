# Vitest MPA Project

Sets up a Vite MPA project with Cloudflare. Demonstrates Vitest unit tests and integration tests using PlayWright against 'vite preview' started application that is served
from production build.

## Features

- Vite-based MPA structure.
- Copies to output also HTML files that are not linked to root.
- Processes site urls (e.g. https://test.com/asset.jpg) in HTML meta tags and JSON-LD so
  that they too have hash-components in file names for cache-busting.
- Cloudflare integration.
- Vitest unit testing with Cloudflare.
- Playwright integration tests against production build with Cloudflare.

## Getting Started

```bash
npm install
npm run test
npm run build
npm run integration-test
```

## Issues

- Code coverage does not work yet: [https://github.com/cloudflare/workers-sdk/issues/5266](https://github.com/cloudflare/workers-sdk/issues/5266).
