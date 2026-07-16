const AUTH_MUTATION_LOCK_NAME = 'kish2note:auth-credential-mutation';
const AUTH_MUTATION_TICKET_PREFIX = 'kish2note:auth-mutation-ticket:';
const AUTH_MUTATION_TICKET_TTL = 2 * 60 * 1000;
const AUTH_MUTATION_WAIT_TIMEOUT = 20 * 1000;

function createLockOwner() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function waitForMutationStorage(milliseconds = 80) {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('storage', handleStorage);
      resolve();
    };
    const handleStorage = (event) => {
      if (String(event.key ?? '').startsWith(AUTH_MUTATION_TICKET_PREFIX)) finish();
    };
    const timer = window.setTimeout(finish, milliseconds);
    window.addEventListener('storage', handleStorage);
  });
}

function mutationTicketEntries(now = Date.now()) {
  const entries = [];
  const keys = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(AUTH_MUTATION_TICKET_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    try {
      const value = JSON.parse(raw);
      const expiresAt = Number(value?.expiresAt);
      const owner = String(value?.owner ?? '');
      const number = Number(value?.number);
      if (!owner || !Number.isFinite(expiresAt) || expiresAt <= now || !Number.isFinite(number)) {
        if (window.localStorage.getItem(key) === raw) window.localStorage.removeItem(key);
        return;
      }
      entries.push({
        key,
        raw,
        owner,
        number,
        choosing: Boolean(value.choosing),
        expiresAt
      });
    } catch {
      if (window.localStorage.getItem(key) === raw) window.localStorage.removeItem(key);
    }
  });
  return entries;
}

function writeMutationTicket(key, ticket) {
  window.localStorage.setItem(key, JSON.stringify(ticket));
}

function removeMutationTicket(key, owner) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const value = JSON.parse(raw);
    if (value?.owner === owner && window.localStorage.getItem(key) === raw) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Leave an unprovable ticket to expire instead of deleting another tab's lock.
  }
}

async function withLocalStorageMutationLock(operation) {
  if (typeof window === 'undefined') return operation();
  const owner = createLockOwner();
  const key = `${AUTH_MUTATION_TICKET_PREFIX}${owner}`;
  const ticket = {
    owner,
    choosing: true,
    number: 0,
    expiresAt: Date.now() + AUTH_MUTATION_TICKET_TTL
  };
  const deadline = Date.now() + AUTH_MUTATION_WAIT_TIMEOUT;
  let heartbeat = null;

  try {
    writeMutationTicket(key, ticket);
    const maxNumber = mutationTicketEntries().reduce(
      (maximum, entry) => Math.max(maximum, entry.number),
      0
    );
    ticket.choosing = false;
    ticket.number = maxNumber + 1;
    ticket.expiresAt = Date.now() + AUTH_MUTATION_TICKET_TTL;
    writeMutationTicket(key, ticket);

    while (true) {
      const now = Date.now();
      if (now >= deadline) throw new Error('账户安全锁等待超时，请稍后重试。');
      if (ticket.expiresAt - now < AUTH_MUTATION_TICKET_TTL / 2) {
        ticket.expiresAt = now + AUTH_MUTATION_TICKET_TTL;
        writeMutationTicket(key, ticket);
      }
      const blocked = mutationTicketEntries(now).some((entry) => {
        if (entry.owner === owner) return false;
        if (entry.choosing) return true;
        return entry.number < ticket.number
          || (entry.number === ticket.number && entry.owner < owner);
      });
      if (!blocked) break;
      await waitForMutationStorage();
    }

    const ownRecord = mutationTicketEntries().find((entry) => entry.owner === owner);
    if (!ownRecord || ownRecord.number !== ticket.number) {
      throw new Error('无法确认账户安全锁，请稍后重试。');
    }

    heartbeat = window.setInterval(() => {
      try {
        const raw = window.localStorage.getItem(key);
        const current = raw ? JSON.parse(raw) : null;
        if (current?.owner !== owner || Number(current?.number) !== ticket.number) return;
        ticket.expiresAt = Date.now() + AUTH_MUTATION_TICKET_TTL;
        writeMutationTicket(key, ticket);
      } catch {
        // The next operation revalidates the ticket; this lease fails closed by TTL.
      }
    }, Math.floor(AUTH_MUTATION_TICKET_TTL / 3));

    return await operation();
  } finally {
    if (heartbeat !== null) window.clearInterval(heartbeat);
    removeMutationTicket(key, owner);
  }
}

async function withNavigatorLock(mode, operation) {
  const controller = new AbortController();
  let entered = false;
  const timeout = window.setTimeout(() => controller.abort(), AUTH_MUTATION_WAIT_TIMEOUT);
  try {
    return await globalThis.navigator.locks.request(
      AUTH_MUTATION_LOCK_NAME,
      { mode, signal: controller.signal },
      async () => {
        entered = true;
        window.clearTimeout(timeout);
        return operation();
      }
    );
  } catch (error) {
    window.clearTimeout(timeout);
    if (entered) throw error;
    if (error?.name === 'AbortError') throw new Error('账户安全锁等待超时，请稍后重试。');
    return withLocalStorageMutationLock(operation);
  }
}

export async function withAuthMutationLock(operation) {
  if (typeof window === 'undefined') return operation();
  if (typeof globalThis.navigator?.locks?.request === 'function') {
    return withNavigatorLock('exclusive', operation);
  }
  return withLocalStorageMutationLock(operation);
}

export async function withStableAuthSession(operation) {
  if (typeof window === 'undefined') return operation();
  if (typeof globalThis.navigator?.locks?.request === 'function') {
    return withNavigatorLock('shared', operation);
  }
  // The storage fallback has no shared mode, so serialize for correctness.
  return withLocalStorageMutationLock(operation);
}
