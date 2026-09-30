import {
  intervalFor,
  minutes,
  netMinutes,
} from '../../lib/optimus-hours.js';

const ORIGIN = 'https://optimus.consultoriaprime.com';
const ACCESS = 'hb_optimus_access';
const IDENTITY = 'hb_optimus_identity';
const COOKIE_PATH = '/optimus/api';

function reply(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function cookies(request) {
  return Object.fromEntries(
    (request.headers.get('Cookie') || '')
      .split(';')
      .map((part) => {
        const at = part.indexOf('=');
        return at < 0
          ? ['', '']
          : [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))];
      })
      .filter(([name]) => name),
  );
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function signature(login, token) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(login)),
    ),
  );
}

async function session(request) {
  const jar = cookies(request);
  const token = jar[ACCESS];
  const identity = jar[IDENTITY];
  if (!token || !identity) return null;
  const dot = identity.lastIndexOf('.');
  if (dot < 1) return null;
  const login = identity.slice(0, dot);
  const actual = identity.slice(dot + 1);
  const expected = await signature(login, token);
  if (actual.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++)
    mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch ? null : { login, token };
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function agendaItems(data, login) {
  const users = data?.data?.Items?.users || [];
  const user = users.find(
    (entry) =>
      String(entry.userCode || '').toLowerCase() === login.toLowerCase(),
  );
  if (!user) return [];
  return (user.tasks || []).flatMap((day) =>
    (day.tasks || []).map((item) => ({
      date: day.date,
      customer: String(item.customer || ''),
      emitenteName: String(item.nome_emit || ''),
      emitente: String(item.cod_emitente || ''),
      project: String(item.cod_projeto || ''),
      projectName: String(item.descProjeto || ''),
      activity: String(item.cod_atividade || ''),
      activityName: String(item.descAtividade || ''),
      start: String(item.hrIni || ''),
      end: String(item.hrFim || ''),
      location: item.local,
      status: String(item.status || ''),
      posted: item['rap-apontado'] === true,
    })),
  );
}

async function upstream(path, token, options = {}) {
  return fetch(`${ORIGIN}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
  });
}

async function agendas(login, token, start, end) {
  const params = new URLSearchParams({
    pDataIni: start,
    pDataFim: end,
    pUser: login,
  });
  const response = await upstream(`/api/external/agendas?${params}`, token);
  if (!response.ok)
    throw new Error(
      `Optimus respondeu ${response.status} na consulta de agendas.`,
    );
  return agendaItems(await response.json(), login);
}

function text(value, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalized(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function sameClient(sheet, item) {
  const expected = normalized(sheet);
  if (expected.length < 4) return false;
  return [item.customer, item.emitenteName].some((name) => {
    const actual = normalized(name);
    return (
      actual === expected ||
      (Math.min(actual.length, expected.length) >= 6 &&
        (actual.startsWith(expected) || expected.startsWith(actual)))
    );
  });
}

function makePayload(item, login, authorizedBy, narrative, tipoHora) {
  const totalMinutes = netMinutes(item.start, item.end);
  const interval = intervalFor(item.start, item.end);
  const hhmm = `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  const stamp = Math.floor(Date.now() / 1000);
  const code = login.toUpperCase();
  const compactDate = item.date.replaceAll('-', '');
  const rapId = `${code}${item.project}${compactDate}${stamp}`;
  return {
    'tt-relat-atend': [
      {
        autorizacao: authorizedBy,
        'cod-emitente': item.emitente,
        'cod-projeto': item.project,
        cod_usuario: code,
        'data-rap': item.date,
        'dt-impressao': item.date,
        'dt-upload': item.date,
        'hora-atend-fim': item.end,
        'hora-atend-ini': item.start,
        'hora-interv-ini': interval.start,
        'hora-interv-fim': interval.end,
        'hora-total': hhmm,
        'hora-total-dec': totalMinutes / 60,
        local: Number(item.location),
        'num-id-rap': rapId,
        'cont-upload': 1,
      },
    ],
    'tt-apontamentos': [
      {
        'cod-atividade': item.activity,
        'cod-projeto': item.project,
        cod_usuario: code,
        'data-apto': item.date,
        'desc-atividade': item.activityName,
        'dt-upload': item.date,
        'hora-fim': item.end,
        'hora-ini': item.start,
        'hora-total': hhmm,
        'id-apontamento': `${code}${item.project}${item.activity}${compactDate}${stamp}`,
        narrativa: narrative,
        'num-id-rap': rapId,
        'qtd-horas': totalMinutes / 60,
        'tipo-hora': tipoHora,
        upload: true,
        'ci-apto-com-ci': false,
        'ci-tipo': 0,
        'ci-resumo': '',
        'ci-narrativa': '',
      },
    ],
    'tt-apontamentos-desp': [],
  };
}

export async function onRequest({ request, params }) {
  const action = params.action;
  const method = request.method;
  if (method === 'POST' && !sameOrigin(request))
    return reply({ error: 'Origem não permitida.' }, 403);
  try {
    if (action === 'login' && method === 'POST') {
      const body = await request.json();
      const loginOrEmail = text(body.loginOrEmail, 160);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!loginOrEmail || !password || password.length > 512)
        return reply({ error: 'Informe usuário e senha.' }, 400);
      const response = await upstream('/api/auth/login', null, {
        method: 'POST',
        body: JSON.stringify({
          loginOrEmail,
          password,
          audit: body.audit || {},
        }),
      });
      if (!response.ok)
        return reply(
          { error: 'Não foi possível entrar. Confira usuário e senha.' },
          401,
        );
      const result = await response.json();
      const token = result.access_token;
      const login = result.user?.login;
      if (
        typeof token !== 'string' ||
        typeof login !== 'string' ||
        !token ||
        !login
      )
        return reply({ error: 'Resposta de login incompleta.' }, 502);
      const identity = `${login}.${await signature(login, token)}`;
      const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      headers.append(
        'Set-Cookie',
        `${ACCESS}=${encodeURIComponent(token)}; Path=${COOKIE_PATH}; Max-Age=7200; HttpOnly; Secure; SameSite=Strict`,
      );
      headers.append(
        'Set-Cookie',
        `${IDENTITY}=${encodeURIComponent(identity)}; Path=${COOKIE_PATH}; Max-Age=7200; HttpOnly; Secure; SameSite=Strict`,
      );
      return new Response(
        JSON.stringify({ login, name: result.user?.name || login }),
        { status: 200, headers },
      );
    }
    if (action === 'logout' && method === 'POST') {
      const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      headers.append(
        'Set-Cookie',
        `${ACCESS}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      );
      headers.append(
        'Set-Cookie',
        `${IDENTITY}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      );
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    const auth = await session(request);
    if (!auth)
      return reply({ error: 'Sessão expirada. Entre novamente.' }, 401);
    if (action === 'me' && method === 'GET')
      return reply({ login: auth.login });
    if (action === 'agendas' && method === 'GET') {
      const url = new URL(request.url);
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (
        !date(start) ||
        !date(end) ||
        start > end ||
        Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) >
          366 * 86400000
      )
        return reply({ error: 'Período inválido.' }, 400);
      return reply({
        items: await agendas(auth.login, auth.token, start, end),
      });
    }
    if (action === 'submit' && method === 'POST') {
      const body = await request.json();
      const wanted = body.agenda;
      const authorizedBy = text(body.authorizedBy, 200);
      const narrative = text(body.narrative, 4000);
      if (
        !wanted ||
        !date(wanted.date) ||
        !authorizedBy ||
        !narrative ||
        !Number.isInteger(body.sheetMinutes) ||
        !date(body.sheetDate) ||
        !text(body.sheetCustomer, 200)
      )
        return reply({ error: 'Dados do apontamento incompletos.' }, 400);
      const current = await agendas(
        auth.login,
        auth.token,
        wanted.date,
        wanted.date,
      );
      const matches = current.filter((item) =>
        ['date', 'emitente', 'project', 'activity', 'start', 'end'].every(
          (key) => String(item[key]) === String(wanted[key]),
        ),
      );
      if (matches.length !== 1)
        return reply(
          { error: 'Agenda não encontrada ou ambígua. Atualize o período.' },
          409,
        );
      const item = matches[0];
      if (body.sheetDate !== item.date || !sameClient(body.sheetCustomer, item))
        return reply(
          { error: 'Cliente ou data da planilha não corresponde à agenda.' },
          409,
        );
      if (item.posted)
        return reply({ error: 'Esta agenda já possui apontamento.' }, 409);
      const totalMinutes = netMinutes(item.start, item.end);
      if (
        !Number.isFinite(totalMinutes) ||
        totalMinutes <= 0 ||
        totalMinutes !== body.sheetMinutes
      )
        return reply(
          {
            error:
              'Horas da planilha e da agenda, descontado o intervalo, são diferentes. Revise a linha.',
          },
          409,
        );
      if (![1, 2, 3].includes(Number(item.location)))
        return reply({ error: 'Local da agenda não reconhecido.' }, 409);
      const query = new URLSearchParams({
        pUser: auth.login,
        pProj: item.project,
      });
      const detailsResponse = await upstream(
        `/api/external/dados-apt?${query}`,
        auth.token,
      );
      if (!detailsResponse.ok)
        return reply(
          { error: 'Não foi possível validar o projeto e a atividade.' },
          502,
        );
      const details = await detailsResponse.json();
      const projects =
        details?.Items?.values?.flatMap((value) => value.projetos || []) || [];
      const project = projects.find(
        (entry) =>
          String(entry.cod_projeto) === item.project &&
          String(entry.cod_emitente) === item.emitente,
      );
      const activity = project?.projetosAtiv?.find(
        (entry) => String(entry.cod_atividade) === item.activity,
      );
      const tipoHora = String(activity?.tipo_hora || '');
      if (
        !tipoHora ||
        !details?.Items?.tipoHora?.some(
          (entry) => String(entry.tipo_hora) === tipoHora,
        )
      )
        return reply(
          { error: 'Tipo de hora da atividade não confirmado.' },
          409,
        );
      const payload = makePayload(
        item,
        auth.login,
        authorizedBy,
        narrative,
        tipoHora,
      );
      const response = await upstream('/api/external/postApt', auth.token, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        return reply(
          { error: `Optimus recusou o apontamento (HTTP ${response.status}).` },
          502,
        );
      const result = await response.json().catch(() => ({}));
      if (String(result?.data?.status || result?.status || '') === '500')
        return reply({ error: 'Optimus recusou o apontamento.' }, 502);
      return reply({
        ok: true,
        rapId: payload['tt-relat-atend'][0]['num-id-rap'],
      });
    }
    return reply({ error: 'Operação não encontrada.' }, 404);
  } catch {
    return reply(
      { error: 'Falha de comunicação com o Optimus. Tente novamente.' },
      502,
    );
  }
}

export { agendaItems, makePayload, minutes };
