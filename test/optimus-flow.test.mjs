import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { onRequest } from '../functions/api/[action].js';
import { intervalFor, netMinutes } from '../lib/optimus-hours.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fetchUrl(input) {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

const agenda = {
  date: '2026-09-10',
  numTasks: 1,
  tasks: [
    {
      customer: 'SUPORTE REI',
      nome_emit: 'CLIENTE EXEMPLO',
      cod_emitente: '104',
      cod_projeto: '4482',
      descProjeto: 'PROJETO EXEMPLO',
      cod_atividade: '200.01',
      descAtividade: 'ATIVIDADE EXEMPLO',
      hrIni: '08:00',
      hrFim: '10:00',
      local: 2,
      status: 'Firme',
      'rap-apontado': false,
    },
  ],
};

function upstreamResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function signIn() {
  globalThis.fetch = async () =>
    upstreamResponse(
      {
        access_token: 'test-token',
        user: { login: 'example', name: 'Pessoa Exemplo' },
      },
      201,
    );
  const response = await onRequest({
    request: new Request('https://hbsystem.app/optimus/api/login', {
      method: 'POST',
      headers: {
        Origin: 'https://hbsystem.app',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        loginOrEmail: 'example',
        password: 'test-password',
      }),
    }),
    params: { action: 'login' },
  });
  assert.equal(response.status, 200);
  const cookies = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookies.includes('HttpOnly') === false); // Cookie attributes are on the response, not the request.
  assert.ok(
    response.headers
      .getSetCookie()
      .every(
        (value) =>
          value.includes('HttpOnly') && value.includes('SameSite=Strict'),
      ),
  );
  return cookies;
}

function request(action, method, cookie, body) {
  return new Request(`https://hbsystem.app/optimus/api/${action}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: 'https://hbsystem.app',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('login keeps token in HttpOnly cookies and agendas are scoped to signed login', async () => {
  const cookie = await signIn();
  let requested = '';
  globalThis.fetch = async (url) => {
    requested = fetchUrl(url);
    return upstreamResponse({
      data: { Items: { users: [{ userCode: 'example', tasks: [agenda] }] } },
    });
  };
  const response = await onRequest({
    request: new Request(
      'https://hbsystem.app/optimus/api/agendas?start=2026-09-01&end=2026-09-30',
      { headers: { Cookie: cookie } },
    ),
    params: { action: 'agendas' },
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].project, '4482');
  assert.ok(requested.includes('pUser=example'));
  assert.ok(!JSON.stringify(result).includes('test-token'));
});

test('mismatched hours and already posted agendas cannot be submitted', async () => {
  const cookie = await signIn();
  let posts = 0;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') posts++;
    return upstreamResponse({
      data: { Items: { users: [{ userCode: 'example', tasks: [agenda] }] } },
    });
  };
  const input = {
    agenda: {
      date: '2026-09-10',
      emitente: '104',
      project: '4482',
      activity: '200.01',
      start: '08:00',
      end: '10:00',
    },
    sheetDate: '2026-09-10',
    sheetCustomer: 'SuporteRei',
    authorizedBy: 'Responsável',
    narrative: 'Atividade executada',
    sheetMinutes: 60,
  };
  const mismatch = await onRequest({
    request: request('submit', 'POST', cookie, input),
    params: { action: 'submit' },
  });
  assert.equal(mismatch.status, 409);
  assert.equal(posts, 0);
  const posted = {
    ...agenda,
    tasks: [{ ...agenda.tasks[0], 'rap-apontado': true }],
  };
  globalThis.fetch = async () =>
    upstreamResponse({
      data: { Items: { users: [{ userCode: 'example', tasks: [posted] }] } },
    });
  const duplicate = await onRequest({
    request: request('submit', 'POST', cookie, { ...input, sheetMinutes: 120 }),
    params: { action: 'submit' },
  });
  assert.equal(duplicate.status, 409);
});

test('ready row uses project activity type and sends the expected RAP structure', async () => {
  const cookie = await signIn();
  let submitted;
  const lunchAgenda = {
    ...agenda,
    tasks: [{ ...agenda.tasks[0], hrFim: '17:00' }],
  };
  globalThis.fetch = async (url, options) => {
    if (fetchUrl(url).includes('/agendas?'))
      return upstreamResponse({
        data: {
          Items: { users: [{ userCode: 'example', tasks: [lunchAgenda] }] },
        },
      });
    if (fetchUrl(url).includes('/dados-apt?'))
      return upstreamResponse({
        Items: {
          values: [
            {
              projetos: [
                {
                  cod_projeto: '4482',
                  cod_emitente: '104',
                  projetosAtiv: [
                    { cod_atividade: '200.01', tipo_hora: '2000' },
                  ],
                },
              ],
            },
          ],
          tipoHora: [{ tipo_hora: '2000' }],
        },
      });
    if (fetchUrl(url).endsWith('/postApt')) {
      submitted = JSON.parse(options.body);
      return upstreamResponse({ status: '201' }, 201);
    }
    throw new Error('Unexpected URL');
  };
  const input = {
    agenda: {
      date: '2026-09-10',
      emitente: '104',
      project: '4482',
      activity: '200.01',
      start: '08:00',
      end: '17:00',
    },
    sheetDate: '2026-09-10',
    sheetCustomer: 'SuporteRei',
    authorizedBy: 'Responsável',
    narrative: 'Atividade executada',
    sheetMinutes: 480,
  };
  const response = await onRequest({
    request: request('submit', 'POST', cookie, input),
    params: { action: 'submit' },
  });
  assert.equal(response.status, 200);
  assert.equal(submitted['tt-relat-atend'][0]['hora-total-dec'], 8);
  assert.equal(submitted['tt-relat-atend'][0]['hora-total'], '08:00');
  assert.equal(submitted['tt-relat-atend'][0]['hora-interv-ini'], '11:50');
  assert.equal(submitted['tt-relat-atend'][0]['hora-interv-fim'], '12:50');
  assert.equal(submitted['tt-relat-atend'][0].autorizacao, 'Responsável');
  assert.equal(submitted['tt-apontamentos'][0]['tipo-hora'], '2000');
  assert.equal(submitted['tt-apontamentos'][0]['qtd-horas'], 8);
  assert.equal(
    submitted['tt-apontamentos'][0].narrativa,
    'Atividade executada',
  );
  assert.deepEqual(submitted['tt-apontamentos-desp'], []);
});

test('net hours reconcile with the Optimus September statement', () => {
  const periods = [
    ...Array(19).fill(['08:00', '17:00']),
    ['08:00', '16:30'],
    ...Array(2).fill(['08:00', '15:00']),
    ...Array(2).fill(['08:00', '10:00']),
    ...Array(2).fill(['08:00', '12:00']),
  ];
  // The statement also has a 13:00–20:00 entry instead of one 08:00–15:00 entry.
  periods[21] = ['13:00', '20:00'];
  assert.equal(
    periods.reduce((sum, [start, end]) => sum + netMinutes(start, end), 0),
    183.5 * 60,
  );
  assert.equal(netMinutes('13:00', '20:00'), 360);
  assert.equal(netMinutes('13:00', '19:00'), 360);
  assert.deepEqual(intervalFor('13:00', '20:00'), {
    start: '11:50',
    end: '12:50',
    minutes: 60,
  });
});

test('cross-origin write is rejected before the Optimus API is called', async () => {
  globalThis.fetch = async () => {
    throw new Error('Network call was not expected');
  };
  const response = await onRequest({
    request: new Request('https://hbsystem.app/optimus/api/login', {
      method: 'POST',
      headers: {
        Origin: 'https://example.org',
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
    params: { action: 'login' },
  });
  assert.equal(response.status, 403);
});
