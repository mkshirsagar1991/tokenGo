'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/feedback';
import { SelectField, TextAreaField, TextField } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, TableCard, TableEmpty } from '@/components/ui/table';
import { isStaleProblem, toAction } from '@/lib/client/actions';
import { humanize } from '@/lib/format';
import { CODE_PATTERN, FLOW_TYPES, type Category, type ServiceType } from '../types';

/** Enable/disable with a confirmation that explains the consequence (a category switch affects what customers can see and book). */
export function ToggleCategoryButton({ category }: { category: Category }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!can('category:manage')) return null;
  const enabling = !category.is_active;
  return (
    <>
      <Button size="sm" variant={enabling ? 'secondary' : 'outline-danger'} onClick={() => setOpen(true)}>
        {enabling ? 'Enable' : 'Disable'}
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title={`${enabling ? 'Enable' : 'Disable'} “${category.name}”?`}
          description={enabling ? 'The category becomes available to customers.' : 'The category is hidden from customers.'}
          effects={
            enabling
              ? ['It appears on customers’ home screens, and services under it (whose own switches are on) become bookable.', 'Make sure providers, service types and policies for this vertical are ready first.']
              : ['It disappears from customers’ home screens and services under it stop being offerable.', 'This action does not cancel any existing booking; handle those separately.', 'You can enable it again at any time.']
          }
          confirmLabel={enabling ? 'Enable category' : 'Disable category'}
          tone={enabling ? 'primary' : 'danger'}
          onConfirm={async () => {
            const res = await bff.patch(`/admin/categories/${category.id}`, { is_active: enabling, expected_version: category.version });
            if (res.ok || isStaleProblem(res.problem.code)) router.refresh();
            return toAction(res, enabling ? 'Category enabled.' : 'Category disabled.');
          }}
        />
      ) : null}
    </>
  );
}

export function CategoriesTable({ categories }: { categories: Category[] }) {
  return (
    <TableCard caption="Categories">
      <THead>
        <tr>
          <TH stickyFirst>Category</TH>
          <TH>Code</TH>
          <TH>Booking flow</TH>
          <TH>Order</TH>
          <TH>Status</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {categories.length === 0 ? (
          <TableEmpty colSpan={6}>No categories.</TableEmpty>
        ) : (
          categories.map((c) => (
            <TR key={c.id}>
              <TD stickyFirst>
                <Link href={`/catalog/categories/${c.id}`} className="font-medium text-brand-soft-fg hover:underline">
                  {c.name}
                </Link>
                {c.description ? <p className="max-w-xs truncate text-xs text-fg-subtle">{c.description}</p> : null}
              </TD>
              <TD mono>{c.code}</TD>
              <TD>{humanize(c.booking_flow_type)}</TD>
              <TD className="tabular-nums">{c.sort_order}</TD>
              <TD>{c.is_active ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}</TD>
              <TD className="text-right">
                <ToggleCategoryButton category={c} />
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </TableCard>
  );
}

export function CreateCategoryButton() {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [flow, setFlow] = useState<string>('APPOINTMENT_SLOT');
  if (!can('category:manage')) return null;
  const codeOk = CODE_PATTERN.test(code);
  const valid = codeOk && name.trim().length >= 1 && name.trim().length <= 100;
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New category
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title="New category"
          description="Adds a vertical to the catalogue. It starts DISABLED so customers do not see it until you enable it."
          effects={['The code is permanent and must be unique.', 'Nothing is shown to customers until you enable the category.']}
          confirmLabel="Create category"
          canConfirm={valid}
          onConfirm={async () => {
            const res = await bff.post('/admin/categories', { code, name: name.trim(), description: description.trim() || undefined, booking_flow_type: flow, is_active: false });
            if (res.ok) router.refresh();
            return toAction(res, 'Category created (disabled).');
          }}
        >
          <div className="grid gap-3">
            <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} required hint="Lowercase letters, digits and underscores; 2–41 characters; starts with a letter." error={code && !codeOk ? 'Use lowercase snake_case, e.g. pet_grooming.' : undefined} className="font-mono" spellCheck={false} />
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
            <TextAreaField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="min-h-16" />
            <SelectField label="Booking flow" value={flow} onChange={(e) => setFlow(e.target.value)} options={FLOW_TYPES.map((f) => ({ value: f, label: humanize(f) }))} />
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

export function ServiceTypesSection({ category, serviceTypes }: { category: Category; serviceTypes: ServiceType[] }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [creating, setCreating] = useState(false);
  const [toggle, setToggle] = useState<ServiceType | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const manage = can('category:manage');
  const valid = CODE_PATTERN.test(code) && name.trim().length >= 1;

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-subtle">Service types</h2>
        {manage ? (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            New service type
          </Button>
        ) : null}
      </div>
      <TableCard caption={`Service types in ${category.name}`}>
        <THead>
          <tr>
            <TH stickyFirst>Name</TH>
            <TH>Code</TH>
            <TH>Order</TH>
            <TH>Status</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </tr>
        </THead>
        <TBody>
          {serviceTypes.length === 0 ? (
            <TableEmpty colSpan={5}>No service types in this category yet.</TableEmpty>
          ) : (
            serviceTypes.map((s) => (
              <TR key={s.id}>
                <TD stickyFirst>
                  <span className="font-medium">{s.name}</span>
                  {s.description ? <p className="max-w-xs truncate text-xs text-fg-subtle">{s.description}</p> : null}
                </TD>
                <TD mono>{s.code}</TD>
                <TD className="tabular-nums">{s.sort_order}</TD>
                <TD>{s.is_active ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}</TD>
                <TD className="text-right">
                  {manage ? (
                    <Button size="sm" variant={s.is_active ? 'outline-danger' : 'secondary'} onClick={() => setToggle(s)}>
                      {s.is_active ? 'Disable' : 'Enable'}
                    </Button>
                  ) : null}
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </TableCard>

      {creating ? (
        <ConfirmDialog
          open
          onClose={() => setCreating(false)}
          title={`New service type in ${category.name}`}
          description="A service type is something providers can offer (for example “Haircut”)."
          effects={['The code is permanent and must be unique within this category.']}
          confirmLabel="Create service type"
          canConfirm={valid}
          onConfirm={async () => {
            const res = await bff.post(`/admin/categories/${category.id}/service-types`, { code, name: name.trim() });
            if (res.ok) router.refresh();
            return toAction(res, 'Service type created.');
          }}
        >
          <div className="grid gap-3">
            <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} required className="font-mono" spellCheck={false} hint="Lowercase snake_case, e.g. haircut." error={code && !CODE_PATTERN.test(code) ? 'Use lowercase snake_case.' : undefined} />
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </div>
        </ConfirmDialog>
      ) : null}

      {toggle ? (
        <ConfirmDialog
          open
          onClose={() => setToggle(null)}
          title={`${toggle.is_active ? 'Disable' : 'Enable'} “${toggle.name}”?`}
          description={toggle.is_active ? 'Providers’ services of this type stop being offerable to customers.' : 'Providers’ services of this type become offerable again.'}
          effects={toggle.is_active ? ['Existing bookings are not cancelled by this action.'] : []}
          confirmLabel={toggle.is_active ? 'Disable service type' : 'Enable service type'}
          tone={toggle.is_active ? 'danger' : 'primary'}
          onConfirm={async () => {
            const res = await bff.patch(`/admin/service-types/${toggle.id}`, { is_active: !toggle.is_active });
            if (res.ok) router.refresh();
            return toAction(res, toggle.is_active ? 'Service type disabled.' : 'Service type enabled.');
          }}
        />
      ) : null}
    </>
  );
}
