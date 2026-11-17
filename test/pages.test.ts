import { describe, expect, it } from 'vitest';
import { scenarios } from '../preview/scenarios.ts';
import { selectionPage } from '../src/pages.ts';

describe('pages', () => {
  it.each(scenarios.map((s) => [s.path, s] as const))('renders the preview scenario %s', (_path, scenario) => {
    const page = scenario.render();
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('</body>');
  });

  it('shows names and labels from the SSO and the config as text, never as markup', () => {
    const page = scenarios.find((s) => s.path === 'selection/hostile')!.render();
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<img');
    expect(page).not.toContain('<b>');
    expect(page).toContain('&lt;script&gt;alert(&quot;name&quot;)');
  });

  it('shows the Personal identity first, then each Target, each with a button posting its id', () => {
    const page = selectionPage({
      action: '/interaction/u1/choose',
      csrf: 'token-123',
      person: { sub: 's', username: 'alice', claims: { sub: 's', name: 'Alice', email: 'a@x' }, groups: [] },
      targets: [
        { id: 'family', label: 'Family', allowedGroups: ['g'], sessionTtl: 60, claims: { sub: 'f', email: 'f@x' } },
      ],
    });

    expect(page).toContain('<form method="post" action="/interaction/u1/choose">');
    expect(page).toContain('<input type="hidden" name="csrf" value="token-123">');
    expect(page).toContain('Signed in as <strong>Alice</strong> (a@x)');
    const personal = page.indexOf('value="personal" aria-label="Log in as Alice (yourself)"');
    const family = page.indexOf('value="family" aria-label="Log in as Family"');
    expect(personal).toBeGreaterThan(0);
    expect(family).toBeGreaterThan(personal);
    expect(page).toContain('<span class="email">f@x</span>');
  });
});
