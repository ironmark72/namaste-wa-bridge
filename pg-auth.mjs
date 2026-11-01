// Baileys auth state kept in Postgres (Supabase) instead of files, so the
// WhatsApp login survives restarts and redeploys on hosts with a throwaway
// disk (Render's free plan). Same shape as Baileys' useMultiFileAuthState.

import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

export async function usePgAuthState(sql) {
  await sql`create table if not exists wa_auth (key text primary key, value text not null, updated_at timestamptz not null default now())`;

  const read = async (key) => {
    const rows = await sql`select value from wa_auth where key = ${key}`;
    return rows[0] ? JSON.parse(rows[0].value, BufferJSON.reviver) : null;
  };
  // postgres.js queries only run when awaited, and Baileys fires saveCreds
  // without awaiting it, so these must be real async functions.
  const write = async (key, data) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await sql`insert into wa_auth (key, value) values (${key}, ${value})
              on conflict (key) do update set value = excluded.value, updated_at = now()`;
  };
  const remove = async (key) => {
    await sql`delete from wa_auth where key = ${key}`;
  };

  // Baileys mutates this object in place; saveCreds persists it.
  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              let v = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
              out[id] = v;
            }),
          );
          return out;
        },
        set: async (data) => {
          const jobs = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const v = data[type][id];
              jobs.push(v ? write(`${type}-${id}`, v) : remove(`${type}-${id}`));
            }
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write('creds', creds),
    /** Forget the login (after the phone unlinks) so a fresh QR appears. */
    clear: async () => {
      await sql`delete from wa_auth`;
    },
  };
}
