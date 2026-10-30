import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, stubFetch } from '@/test/render';
import type { Provider } from '../types';
import { ProviderActions } from './provider-actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => '/' }));

const provider = (status: Provider['status']): Provider => ({ id: '01a11551-74f2-7f67-8d6c-320744186e68', display_name: 'Fixture Salon', description: null, status, submitted_at: null, decided_at: null, decision_reason: null, version: 1, created_at: '' });
const ADMIN = ['provider:verify', 'provider:suspend'];

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe('ProviderActions: which actions are offered', () => {
  it.each([
    ['SUBMITTED', ['Start review', 'Approve', 'Reject']],
    ['UNDER_REVIEW', ['Approve', 'Reject']],
    ['APPROVED', ['Suspend']],
    ['SUSPENDED', ['Reinstate']],
  ] as const)('%s offers %j', (status, labels) => {
    renderApp(<ProviderActions provider={provider(status)} />, { permissions: ADMIN });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(labels);
  });

  it('offers nothing for draft/rejected providers and says why', () => {
    renderApp(<ProviderActions provider={provider('REJECTED')} />, { permissions: ADMIN });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/must fix and resubmit/)).toBeInTheDocument();
  });

  it('hides actions the user lacks the permission for and explains', () => {
    renderApp(<ProviderActions provider={provider('SUBMITTED')} />, { permissions: ['provider:read_any'] });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText(/your role does not include the permission/i)).toBeInTheDocument();
  });

  it('splits verify and suspend permissions', () => {
    renderApp(<ProviderActions provider={provider('APPROVED')} />, { permissions: ['provider:verify'] });
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
  });
});

describe('ProviderActions: confirmation and API calls', () => {
  it('reject requires a reason of at least 5 characters, then posts it', async () => {
    const { calls } = stubFetch(() => ({ body: { data: provider('REJECTED') } }));
    const { user } = renderApp(<ProviderActions provider={provider('SUBMITTED')} />, { permissions: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this application?' });
    const submit = within(dialog).getByRole('button', { name: 'Reject' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason for rejection/), 'abc');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason for rejection/), 'def');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/bff/api/admin/providers/01a11551-74f2-7f67-8d6c-320744186e68/reject', body: { reason: 'abcdef' } });
    expect(refresh).toHaveBeenCalled();
  });

  it('approve needs no reason (the API accepts none) but still asks for confirmation', async () => {
    const { calls } = stubFetch(() => ({ body: { data: provider('APPROVED') } }));
    const { user } = renderApp(<ProviderActions provider={provider('UNDER_REVIEW')} />, { permissions: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('dialog', { name: 'Approve this provider?' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.url).toMatch(/\/approve$/);
  });

  it('refreshes the page and shows the API message when the state changed under the operator (409)', async () => {
    stubFetch(() => ({ status: 409, body: { code: 'INVALID_STATE_TRANSITION', detail: 'Cannot approve a provider that is REJECTED', request_id: 'r-9' } }));
    const { user } = renderApp(<ProviderActions provider={provider('UNDER_REVIEW')} />, { permissions: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/changed state/i)).toBeInTheDocument();
    expect(screen.getByText(/Reference: r-9/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('surfaces a 403 from the API as a permission message', async () => {
    stubFetch(() => ({ status: 403, body: { code: 'FORBIDDEN', detail: 'You do not have permission' } }));
    const { user } = renderApp(<ProviderActions provider={provider('UNDER_REVIEW')} />, { permissions: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/do not have permission to do that/i)).toBeInTheDocument();
  });
});
