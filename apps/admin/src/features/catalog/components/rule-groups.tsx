import { Alert, Badge } from '@/components/ui/feedback';
import { Card } from '@/components/ui/layout';
import { TBody, TD, TH, THead, TR, TableCard } from '@/components/ui/table';
import { formatDateTime, shortId } from '@/lib/format';
import { formatBps } from '@/lib/money';
import type { CancellationPolicy, CommissionRule, ScopeOptions } from '../types';
import { groupByScope, versionState, type VersionState } from '../versioning';
import { NewCancellationVersionButton } from './cancellation-form';
import { describeRate } from '../format';
import { NewCommissionVersionButton } from './commission-form';

export function scopeLabel(type: string, id: string | null, options: ScopeOptions): string {
  if (type === 'PLATFORM') return 'Whole platform (default)';
  const name = type === 'CATEGORY' ? options.categories.find((c) => c.value === id)?.label : type === 'PROVIDER' ? options.providers.find((p) => p.value === id)?.label : undefined;
  const kind = type === 'CATEGORY' ? 'Category' : type === 'PROVIDER' ? 'Provider' : type === 'SERVICE_TYPE' ? 'Service type' : 'Provider service';
  return `${kind}: ${name ?? shortId(id)}`;
}

const STATE_BADGE: Record<VersionState, { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  current: { label: 'In force now', tone: 'success' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

const StateBadge = ({ state }: { state: VersionState }) => <Badge tone={STATE_BADGE[state].tone}>{STATE_BADGE[state].label}</Badge>;

export function CommissionGroups({ rules, options, now }: { rules: CommissionRule[]; options: ScopeOptions; now: number }) {
  const groups = groupByScope(rules);
  if (groups.length === 0) return <Alert tone="warn">No commission rules exist. Create the platform default first.</Alert>;
  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const current = g.versions.find((v) => versionState(v, now) === 'current') ?? null;
        return (
          <Card key={g.key} title={scopeLabel(g.scope_type, g.scope_id, options)} description={current ? `In force: ${describeRate(current)} (version ${current.version})` : 'Nothing is in force for this scope right now.'} actions={<NewCommissionVersionButton options={options} initial={{ type: g.scope_type, id: g.scope_id ?? '' }} existing={rules} />} padded={false}>
            <TableCard caption={`Versions for ${scopeLabel(g.scope_type, g.scope_id, options)}`} className="rounded-none border-0">
              <THead>
                <tr>
                  <TH stickyFirst>Version</TH>
                  <TH>Commission</TH>
                  <TH>Effective from</TH>
                  <TH>Effective to</TH>
                  <TH>State</TH>
                </tr>
              </THead>
              <TBody>
                {g.versions.map((v) => (
                  <TR key={v.id}>
                    <TD stickyFirst className="tabular-nums">v{v.version}</TD>
                    <TD className="font-medium">{describeRate(v)}</TD>
                    <TD className="whitespace-nowrap">{formatDateTime(v.effective_from)}</TD>
                    <TD className="whitespace-nowrap">{v.effective_to ? formatDateTime(v.effective_to) : 'Open-ended'}</TD>
                    <TD>
                      <StateBadge state={versionState(v, now)} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </TableCard>
          </Card>
        );
      })}
    </div>
  );
}

export function CancellationGroups({ policies, options, now }: { policies: CancellationPolicy[]; options: ScopeOptions; now: number }) {
  const groups = groupByScope(policies);
  if (groups.length === 0) return <Alert tone="warn">No cancellation policies exist. Create the platform default first.</Alert>;
  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const current = g.versions.find((v) => versionState(v, now) === 'current') ?? null;
        return (
          <Card key={g.key} title={scopeLabel(g.scope_type, g.scope_id, options)} description={current ? `In force: “${current.name}” (version ${current.version})` : 'Nothing is in force for this scope right now.'} actions={<NewCancellationVersionButton options={options} initial={{ type: g.scope_type, id: g.scope_id ?? '' }} existing={policies} />} padded={false}>
            <TableCard caption={`Versions for ${scopeLabel(g.scope_type, g.scope_id, options)}`} className="rounded-none border-0">
              <THead>
                <tr>
                  <TH stickyFirst>Version</TH>
                  <TH>Name</TH>
                  <TH>Refund tiers</TH>
                  <TH align="right">No-show</TH>
                  <TH align="right">Provider cancels</TH>
                  <TH>Effective from</TH>
                  <TH>Effective to</TH>
                  <TH>State</TH>
                </tr>
              </THead>
              <TBody>
                {g.versions.map((v) => (
                  <TR key={v.id}>
                    <TD stickyFirst className="tabular-nums">v{v.version}</TD>
                    <TD className="font-medium">{v.name}</TD>
                    <TD className="text-xs">
                      {v.tiers && v.tiers.length > 0 ? (
                        <ul>
                          {[...v.tiers].sort((a, b) => b.min_hours_before - a.min_hours_before).map((t) => (
                            <li key={t.min_hours_before}>
                              ≥ {t.min_hours_before}h → {formatBps(t.refund_bps)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-fg-subtle" title="The API list endpoint does not return the refund tiers yet">Not provided by the API</span>
                      )}
                    </TD>
                    <TD align="right">{formatBps(v.no_show_refund_bps)}</TD>
                    <TD align="right">{formatBps(v.provider_cancel_refund_bps)}</TD>
                    <TD className="whitespace-nowrap">{formatDateTime(v.effective_from)}</TD>
                    <TD className="whitespace-nowrap">{v.effective_to ? formatDateTime(v.effective_to) : 'Open-ended'}</TD>
                    <TD>
                      <StateBadge state={versionState(v, now)} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </TableCard>
          </Card>
        );
      })}
    </div>
  );
}
