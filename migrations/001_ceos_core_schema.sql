-- CEOS Core Intelligence Database Schema
-- Phase 1: Investment Intelligence Foundation

create extension if not exists "uuid-ossp";

create table if not exists stocks (
  id uuid primary key default uuid_generate_v4(),
  symbol text not null unique,
  market text not null default 'SET',
  company_name text,
  sector text,
  created_at timestamptz default now()
);

create table if not exists financial_metrics (
  id uuid primary key default uuid_generate_v4(),
  stock_id uuid references stocks(id) on delete cascade,
  fiscal_year int not null,
  revenue numeric,
  net_profit numeric,
  roe numeric,
  roa numeric,
  debt_equity numeric,
  eps numeric,
  created_at timestamptz default now()
);

create table if not exists stock_scores (
  id uuid primary key default uuid_generate_v4(),
  stock_id uuid references stocks(id) on delete cascade,
  quality_score numeric default 0,
  growth_score numeric default 0,
  valuation_score numeric default 0,
  risk_score numeric default 0,
  momentum_score numeric default 0,
  alpha_score numeric default 0,
  scoring_date date default current_date
);

create table if not exists portfolios (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  created_at timestamptz default now()
);

create table if not exists portfolio_positions (
  id uuid primary key default uuid_generate_v4(),
  portfolio_id uuid references portfolios(id) on delete cascade,
  stock_id uuid references stocks(id) on delete cascade,
  quantity numeric default 0,
  avg_cost numeric default 0,
  target_weight numeric default 0
);
