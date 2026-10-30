import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@/lib/problem';
import { ConfirmDialog } from './dialog';

vi.mock('next/link', () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

function setup(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn<(i: { reason: string }) => Promise<ActionResult>>(async () => ({ ok: true, message: 'Done it.' }));
  const onClose = vi.fn();
  const utils = render(<ConfirmDialog open onClose={onClose} title="Reject this application?" description="You are rejecting Salon A." effects={['The provider is not bookable.']} confirmLabel="Reject" tone="danger" reason={{ min: 5, max: 100 }} onConfirm={onConfirm} {...over} />);
  return { onConfirm, onClose, user: userEvent.setup(), ...utils };
}
const confirmButton = () => screen.getByRole('button', { name: /^Reject$/ });

describe('ConfirmDialog: reason required', () => {
  it('states exactly what will happen', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Reject this application?' })).toBeInTheDocument();
    expect(screen.getByText('You are rejecting Salon A.')).toBeInTheDocument();
    expect(screen.getByText('The provider is not bookable.')).toBeInTheDocument();
  });

  it('keeps the button disabled until a long-enough reason is typed (spaces do not count)', async () => {
    const { user, onConfirm } = setup();
    expect(confirmButton()).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), '     ');
    expect(confirmButton()).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'abc');
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(/at least 5 characters \(3 so far\)/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Reason/), 'de');
    expect(confirmButton()).toBeEnabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('sends the trimmed reason and closes on success', async () => {
    const { user, onConfirm, onClose } = setup();
    await user.type(screen.getByLabelText(/Reason/), '  documents are blurry  ');
    await user.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'documents are blurry' });
  });

  it('works without a reason when the API accepts none', async () => {
    const { user, onConfirm } = setup({ reason: undefined, confirmLabel: 'Approve', tone: 'primary' });
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn).toBeEnabled();
    await user.click(btn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
  });
});

describe('ConfirmDialog: in-flight protection', () => {
  it('disables the button and Cancel while the request is pending, and ignores a second activation', async () => {
    const gate = deferred<ActionResult>();
    const onConfirm = vi.fn(() => gate.promise);
    const { user, onClose } = setup({ onConfirm });
    await user.type(screen.getByLabelText(/Reason/), 'valid reason');
    await user.click(confirmButton());

    await waitFor(() => expect(confirmButton()).toBeDisabled());
    expect(confirmButton()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.click(confirmButton()).catch(() => undefined); // disabled: nothing happens
    await user.keyboard('{Enter}'); // submitting the form by keyboard must not double-fire either
    expect(onConfirm).toHaveBeenCalledTimes(1);

    gate.resolve({ ok: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cannot be dismissed with Escape while in flight', async () => {
    const gate = deferred<ActionResult>();
    const { user, onClose } = setup({ onConfirm: vi.fn(() => gate.promise) });
    await user.type(screen.getByLabelText(/Reason/), 'valid reason');
    await user.click(confirmButton());
    await waitFor(() => expect(confirmButton()).toBeDisabled());
    const dialog = screen.getByRole('dialog');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    gate.resolve({ ok: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('ConfirmDialog: API errors', () => {
  it('shows the API message and reference inline, stays open and re-enables the button', async () => {
    const { user, onClose } = setup({ onConfirm: vi.fn(async () => ({ ok: false as const, problem: { status: 409, code: 'INVALID_STATE_TRANSITION', detail: 'Cannot reject a provider that is APPROVED', requestId: 'req-42' } })) });
    await user.type(screen.getByLabelText(/Reason/), 'valid reason');
    await user.click(confirmButton());
    expect(await screen.findByText(/no longer possible because the item changed state/i)).toBeInTheDocument();
    expect(screen.getByText(/Reference: req-42/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(confirmButton()).toBeEnabled();
  });

  it('puts an API validation error on the reason box itself', async () => {
    const { user } = setup({ onConfirm: vi.fn(async () => ({ ok: false as const, problem: { status: 422, code: 'VALIDATION_FAILED', detail: 'Request validation failed', errors: { fields: { reason: ['reason must be longer than or equal to 5 characters'] } } } })) });
    await user.type(screen.getByLabelText(/Reason/), 'valid reason');
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('reason must be longer than or equal to 5 characters');
  });

  it('retrying after an error calls the action again', async () => {
    const onConfirm = vi.fn<(i: { reason: string }) => Promise<ActionResult>>().mockResolvedValueOnce({ ok: false, problem: { status: 502, code: 'NETWORK_ERROR', detail: 'down' } }).mockResolvedValueOnce({ ok: true });
    const { user, onClose } = setup({ onConfirm });
    await user.type(screen.getByLabelText(/Reason/), 'valid reason');
    await user.click(confirmButton());
    await screen.findByText(/Could not reach/i);
    await user.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

describe('ConfirmDialog: typed confirmation and caller validation', () => {
  it('requires the exact confirmation text', async () => {
    const { user } = setup({ reason: undefined, confirmText: 'FREEZE', confirmLabel: 'Freeze' });
    const btn = screen.getByRole('button', { name: 'Freeze' });
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText(/Type FREEZE to confirm/), 'freeze');
    expect(btn).toBeDisabled();
    await user.clear(screen.getByLabelText(/Type FREEZE to confirm/));
    await user.type(screen.getByLabelText(/Type FREEZE to confirm/), 'FREEZE');
    expect(btn).toBeEnabled();
  });

  it('honours canConfirm from the caller', () => {
    setup({ reason: undefined, canConfirm: false, confirmLabel: 'Go' });
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
  });

  it('can show a result in place of closing', async () => {
    const { user, onClose } = setup({ reason: undefined, confirmLabel: 'Run', renderResult: () => <p>3 payouts created</p> });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('3 payouts created')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
