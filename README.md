# Monorepo - CEOS Platform

Monorepo that combines two Next.js projects using npm workspaces.

## Projects

- **ceos-platform**: Main platform using Next.js 14
- **clerk-netlify-template**: Authentication template with Clerk

## Quick Start

### Install Dependencies
```bash
npm install
```

### Development

Run individual project:
```bash
npm run dev:platform    # Run ceos-platform
npm run dev:clerk       # Run clerk-netlify-template
```

Run all projects:
```bash
npm run dev:all
```

### Build

```bash
npm run build:all       # Build all projects
```

### Project Structure

```
monorepo/
├── packages/
│   ├── ceos-platform/
│   └── clerk-netlify-template/
├── package.json (root workspaces config)
└── README.md
```

## Workspaces

This monorepo uses npm workspaces to manage dependencies across packages. All packages share the same `node_modules` directory at the root level, reducing disk space and installation time.

## Next Steps

1. Copy files from original repos to their respective package directories
2. Update import paths if needed
3. Install dependencies: `npm install`
4. Test each project runs correctly
