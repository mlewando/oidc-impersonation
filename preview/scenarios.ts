import type { TargetConfig } from '../src/config.ts';
import type { RealPerson } from '../src/identity.ts';
import { errorPage, expiredPage, refusedPage, selectionPage, upstreamFailedPage } from '../src/pages.ts';

// Every page the Bridge renders, with sample data. `pnpm preview` serves each at /<path>, and the
// unit tests render all of them. Add a scenario for any state worth looking at.

export interface Scenario {
  path: string;
  title: string;
  render(): string;
}

/** A Target with the given email claim, `<id>@example.org` by default, or none for `null`. */
const target = (id: string, label: string, email: string | null = `${id}@example.org`): TargetConfig => ({
  id,
  label,
  allowedGroups: ['photos-family'],
  sessionTtl: 8 * 3600,
  claims: email === null ? { sub: `${id}-sub` } : { sub: `${id}-sub`, email },
});

const alice: RealPerson = {
  sub: '9f1c2a7e-0d4b-4c39-8a51-2f6e3b7d1c08',
  username: 'alice',
  claims: { sub: '9f1c2a7e', email: 'alice@example.org', name: 'Alice', preferred_username: 'alice' },
  groups: ['photos-family'],
};

const select = (person: RealPerson, targets: TargetConfig[]) => () =>
  selectionPage({ action: '/interaction/preview/choose', csrf: 'preview-csrf-token', person, targets });

export const scenarios: Scenario[] = [
  {
    path: 'selection',
    title: 'Account selection: 1 Target',
    render: select(alice, [target('family', 'Family')]),
  },
  {
    path: 'selection/several',
    title: 'Account selection: several Targets, 1 without email',
    render: select(alice, [
      target('family', 'Family'),
      target('brief', 'Brief visit'),
      target('archive', 'Photo archive', null),
    ]),
  },
  {
    path: 'selection/many',
    title: 'Account selection: 10 Targets',
    render: select(
      alice,
      Array.from({ length: 10 }, (_, i) => target(`shared-${i + 1}`, `Shared account ${i + 1}`)),
    ),
  },
  {
    path: 'selection/long-names',
    title: 'Account selection: long name and label',
    render: select(
      { ...alice, claims: { ...alice.claims, name: 'Maximiliane Alexandra von Hohenzollern-Sigmaringen' } },
      [
        target(
          'family',
          'The whole extended family, grandparents included, shared photo library',
          'the-whole-extended-family-shared-library@photos.example.org',
        ),
      ],
    ),
  },
  {
    path: 'selection/no-name',
    title: 'Account selection: only a username upstream',
    render: select({ sub: 'b0b', username: 'bob', claims: { sub: 'b0b' }, groups: [] }, [target('family', 'Family')]),
  },
  {
    path: 'selection/hostile',
    title: 'Account selection: markup in names and labels (must show as text)',
    render: select(
      { ...alice, claims: { ...alice.claims, name: '<script>alert("name")</script>' } },
      [target('x"><img src=x onerror=alert(1)>', '<b>bold?</b> & "quoted"')],
    ),
  },
  { path: 'refused', title: 'Sign-in refused', render: refusedPage },
  { path: 'expired', title: 'Sign-in expired', render: expiredPage },
  { path: 'upstream-failed', title: 'Upstream sign-in failed', render: upstreamFailedPage },
  {
    path: 'oidc-error',
    title: 'OIDC error (from oidc-provider)',
    render: () => errorPage('invalid_redirect_uri', "redirect_uri did not match any of the client's registered redirect_uris"),
  },
];
