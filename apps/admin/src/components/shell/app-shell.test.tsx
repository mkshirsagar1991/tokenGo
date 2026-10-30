import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { visibleNav } from '@/config/navigation';
import { renderApp } from '@/test/render';
import { AppShell } from './app-shell';

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const shell = () =>
  renderApp(
    <AppShell groups={visibleNav(['provider:read_any'])} userLabel="+91 ••••• ••077" mode={{ label: 'TEST MODE', tone: 'warn', title: 'Test mode' } as never} environment="development" theme="system" idleTimeoutMs={900_000}>
      <p>page</p>
    </AppShell>,
    { permissions: ['provider:read_any'] },
  );

describe('AppShell navigation drawer (below the lg breakpoint)', () => {
  // jsdom does not apply Tailwind's CSS, so this guards the CONTRACT in the class list: `max-lg:invisible` is what takes a closed,
  // off-screen drawer out of the tab order and the accessibility tree (it used to leave 21 invisible links focusable).
  it('is hidden from keyboard and screen readers while closed, and visible while open', async () => {
    const { user } = shell();
    const drawer = screen.getByLabelText('Main navigation');
    expect(drawer.className).toContain('max-lg:invisible');
    expect(drawer.className).toContain('-translate-x-full');

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(drawer.className).not.toContain('max-lg:invisible');
    expect(drawer.className).toContain('translate-x-0');

    await user.keyboard('{Escape}');
    expect(drawer.className).toContain('max-lg:invisible');
  });

  it('keeps the menu button wired to the drawer for assistive technology', () => {
    shell();
    const open = screen.getByRole('button', { name: 'Open menu' });
    expect(open).toHaveAttribute('aria-controls', 'sidebar');
    expect(open).toHaveAttribute('aria-expanded', 'false');
  });
});
