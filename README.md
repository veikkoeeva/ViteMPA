# Vitest MPA Project: Known Issues

This document highlights issues encountered while building a Multi-Page Application (MPA) with Vite.

For reference, see the related discussion: [Built-in Multi-Page App Support on Build](https://github.com/vitejs/vite/issues/3429).

## Issues

### 1. Image Assets in Meta Tags

Image assets referenced in meta tags are not updated to their cache-busted versions during the build process. Since the build process appends hashed portions to filenames, these references become invalid and point to non-existent assets.

### 2. Image Assets in `application/ld+json` Sections

Similarly, image assets within the `application/ld+json` sections (used for structured data) are not updated to their cache-busted versions. These references also include hashed filenames, leading to broken links.

### 3. Altered Page Structure

The build process modifies the structure of the pages, breaking internal links between MPA pages. As a result, static HTML pages can no longer be accessed directly as expected. Ideally, users should be able to access these static pages seamlessly, while still benefiting from build optimization, cache-busting, and other enhancements.

## It would be nice...

To have these fixed so one could build a MPA application within the Vite tooling. It would be OK to also use Vite preview and build tools and consequently not have this working strictly also as clicking the `.html` pages without a build.

