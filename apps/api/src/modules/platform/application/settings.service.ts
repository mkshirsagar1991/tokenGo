import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock, UnitOfWork } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { SETTINGS, SettingValue, defaultOf, settingDefinition, validateSetting } from '../domain/settings-registry';

export interface SettingView {
  key: string;
  description: string;
  kind: string;
  public: boolean;
  value: SettingValue;
  default: SettingValue;
  /** false = still on the built-in default. */
  customised: boolean;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  constraints: Record<string, unknown>;
}

interface Row {
  key: string;
  value: SettingValue;
  version: number;
  updated_by: string | null;
  updated_at: Date;
}

/** How long a process may serve settings from memory. The API and the worker are separate processes; both converge within this. */
const CACHE_MS = 15_000;

@Injectable()
export class SettingsService {
  private cache?: { loadedAt: number; rows: Map<string, Row> };

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Effective value of one setting (override, else the built-in default). Safe to call from any module. */
  async get<T extends SettingValue>(key: string): Promise<T> {
    const def = settingDefinition(key);
    const row = (await this.rows()).get(key);
    return (row ? row.value : defaultOf(def)) as T;
  }

  async all(): Promise<SettingView[]> {
    const rows = await this.rows(true);
    return Object.keys(SETTINGS)
      .sort()
      .map((key) => this.view(key, rows.get(key)));
  }

  /** What the unauthenticated mobile apps may know. Only settings marked public, never anything else. */
  async publicValues(): Promise<Record<string, SettingValue>> {
    const rows = await this.rows();
    const out: Record<string, SettingValue> = {};
    for (const [key, def] of Object.entries(SETTINGS)) {
      if (def.public) out[key] = rows.get(key)?.value ?? defaultOf(def);
    }
    return out;
  }

  async set(userId: string, key: string, raw: unknown): Promise<SettingView> {
    const value = validateSetting(key, raw);
    const view = await this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const before = (await sql<Row>`SELECT key, value, version, updated_by, updated_at FROM platform.settings WHERE key = ${key} FOR UPDATE`.execute(db)).rows[0];
      const now = this.clock.now();
      const json = JSON.stringify(value);
      const after = (
        await sql<Row>`
          INSERT INTO platform.settings (key, value, version, updated_by, updated_at)
          VALUES (${key}, ${json}::jsonb, 1, ${userId}, ${now})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = platform.settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
          RETURNING key, value, version, updated_by, updated_at`.execute(db)
      ).rows[0]!;
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'settings.changed',
        entityType: 'setting',
        entityId: key,
        before: { value: before ? before.value : defaultOf(settingDefinition(key)), customised: Boolean(before) },
        after: { value: after.value, customised: true },
      });
      return this.view(key, after);
    });
    this.cache = undefined; // this process sees its own change immediately
    return view;
  }

  private view(key: string, row: Row | undefined): SettingView {
    const def = settingDefinition(key);
    const constraints: Record<string, unknown> = {};
    if (def.kind === 'string') Object.assign(constraints, { max_length: def.maxLength, hint: def.patternHint ?? null });
    if (def.kind === 'int') Object.assign(constraints, { min: def.min, max: def.max });
    if (def.kind === 'int_list') Object.assign(constraints, { min: def.min, max: def.max, min_items: def.minItems, max_items: def.maxItems, ascending: def.ascending });
    return {
      key,
      description: def.description,
      kind: def.kind,
      public: def.public,
      value: row ? row.value : defaultOf(def),
      default: defaultOf(def),
      customised: Boolean(row),
      version: row?.version ?? 0,
      updated_at: row ? row.updated_at.toISOString() : null,
      updated_by: row?.updated_by ?? null,
      constraints,
    };
  }

  private async rows(fresh = false): Promise<Map<string, Row>> {
    const now = Date.now();
    if (!fresh && this.cache && now - this.cache.loadedAt < CACHE_MS) return this.cache.rows;
    const res = await sql<Row>`SELECT key, value, version, updated_by, updated_at FROM platform.settings`.execute(this.uow.db<unknown>());
    const rows = new Map(res.rows.filter((r) => r.key in SETTINGS).map((r) => [r.key, r]));
    this.cache = { loadedAt: now, rows };
    return rows;
  }
}
