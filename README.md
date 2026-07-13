# CEOS Platform

A modern platform built with Next.js, Tailwind CSS, shadcn/ui, and Supabase.

## Tech Stack

- **Frontend**: Next.js 14+ with TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: shadcn/ui
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
# or
yarn install
```

### Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Development

```bash
npm run dev
# or
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
├── app/                 # Next.js app directory
├── components/          # React components
│   └── ui/             # shadcn/ui components
├── lib/                # Utility functions
│   └── supabase.ts     # Supabase client
├── types/              # TypeScript types
├── migrations/         # Database migrations
└── public/             # Static assets
```

## Database Migrations

Migrations are stored in the `migrations/` directory.

## License

MIT
