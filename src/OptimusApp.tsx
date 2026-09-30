import { useEffect, useMemo, useRef, useState } from 'react';
import { readSheet } from 'read-excel-file/browser';
import {
  intervalFor,
  netMinutes,
  nonWorkingReason,
} from '../lib/optimus-hours.js';
import './optimus.css';

type Agenda = {
  date: string;
  customer: string;
  emitenteName: string;
  emitente: string;
  project: string;
  projectName: string;
  activity: string;
  activityName: string;
  start: string;
  end: string;
  location: number | string;
  status: string;
  posted: boolean;
};

type Imported = {
  row: number;
  date: string;
  customer: string;
  authorizedBy: string;
  narrative: string;
  sheetMinutes: number;
  agendaKey: string;
  selected: boolean;
  result?: string;
};

type View = 'dashboard' | 'agendas' | 'review' | 'report';
type ReportEntry = { item?: Agenda; row?: Imported };

const api = '/optimus/api';
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const monthStart = `${today.slice(0, 7)}-01`;

function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  return '';
}

function normalize(value: unknown) {
  return cellText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function agendaKey(item: Agenda) {
  return [
    item.date,
    item.emitente,
    item.project,
    item.activity,
    item.start,
    item.end,
  ].join('|');
}

function dateFromCell(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000 && value < 100000)
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000)
      .toISOString()
      .slice(0, 10);
  const input = cellText(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const match = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match)
    return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return '';
}

function minutesFromCell(value: unknown): number {
  if (typeof value === 'number') return Math.round(value * 60);
  const input = cellText(value).trim();
  if (/^\d{1,2}:\d{2}$/.test(input)) {
    const [hours, minutes] = input.split(':').map(Number);
    return hours * 60 + minutes;
  }
  const decimal = Number(input.replace(',', '.'));
  return Number.isFinite(decimal) && input !== ''
    ? Math.round(decimal * 60)
    : NaN;
}

function agendaMinutes(item: Agenda) {
  return netMinutes(item.start, item.end);
}

function intervalLabel(item: Agenda) {
  const interval = intervalFor(item.start, item.end);
  return interval.minutes ? `${interval.start}–${interval.end}` : '—';
}

function hours(minutes: number) {
  return Number.isFinite(minutes)
    ? (minutes / 60).toLocaleString('pt-BR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })
    : '—';
}

function displayDate(date: string) {
  return date ? date.split('-').reverse().join('/') : '—';
}

function csvCell(value: unknown) {
  const raw = cellText(value);
  const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function clientMatches(sheet: string, item: Agenda) {
  const desired = normalize(sheet);
  if (desired.length < 4) return false;
  return [item.customer, item.emitenteName].some((name) => {
    const known = normalize(name);
    return (
      known === desired ||
      (Math.min(known.length, desired.length) >= 6 &&
        (known.startsWith(desired) || desired.startsWith(known)))
    );
  });
}

function matchAgenda(
  row: Omit<Imported, 'agendaKey' | 'selected'>,
  items: Agenda[],
) {
  const sameClient = items.filter(
    (item) => item.date === row.date && clientMatches(row.customer, item),
  );
  if (sameClient.length === 1) return agendaKey(sameClient[0]);
  if (sameClient.length > 1) {
    const sameHours = sameClient.filter(
      (item) => agendaMinutes(item) === row.sheetMinutes,
    );
    if (sameHours.length === 1) return agendaKey(sameHours[0]);
  }
  return '';
}

async function jsonRequest(path: string, options: RequestInit = {}) {
  const response = await fetch(`${api}/${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    login?: string;
    name?: string;
    items?: Agenda[];
  };
  if (!response.ok)
    throw new Error(data.error || `Falha HTTP ${response.status}.`);
  return data;
}

export default function OptimusPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [user, setUser] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [start, setStart] = useState(monthStart);
  const [end, setEnd] = useState(today);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [rows, setRows] = useState<Imported[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [searched, setSearched] = useState(false);
  const [activeView, setActiveView] = useState<View>('dashboard');
  const [appliedPeriod, setAppliedPeriod] = useState({
    start: monthStart,
    end: today,
  });

  useEffect(() => {
    jsonRequest('me')
      .then((data) => setUser(data.login || ''))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const agendaByKey = useMemo(
    () => new Map(agendas.map((item) => [agendaKey(item), item])),
    [agendas],
  );
  const selectedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      if (row.agendaKey)
        counts.set(row.agendaKey, (counts.get(row.agendaKey) || 0) + 1);
    });
    return counts;
  }, [rows]);

  const summary = useMemo(() => {
    const counted = agendas.filter((item) => !nonWorkingReason(item));
    const excluded = agendas.filter((item) => nonWorkingReason(item));
    const totalMinutes = counted.reduce(
      (sum, item) => sum + Math.max(0, agendaMinutes(item) || 0),
      0,
    );
    const excludedMinutes = excluded.reduce(
      (sum, item) => sum + Math.max(0, agendaMinutes(item) || 0),
      0,
    );
    const posted = counted.filter((item) => item.posted);
    const postedMinutes = posted.reduce(
      (sum, item) => sum + Math.max(0, agendaMinutes(item) || 0),
      0,
    );
    const clients = new Map<string, { count: number; minutes: number }>();
    counted.forEach((item) => {
      const name = item.customer || item.emitenteName || 'Não informado';
      const previous = clients.get(name) || { count: 0, minutes: 0 };
      clients.set(name, {
        count: previous.count + 1,
        minutes: previous.minutes + Math.max(0, agendaMinutes(item) || 0),
      });
    });
    return {
      totalMinutes,
      excludedMinutes,
      excludedCount: excluded.length,
      countedCount: counted.length,
      postedMinutes,
      postedCount: posted.length,
      pendingCount: counted.length - posted.length,
      clients: [...clients.entries()]
        .map(([name, values]) => ({ name, ...values }))
        .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    };
  }, [agendas]);

  const reportEntries = useMemo<ReportEntry[]>(() => {
    const included = new Set<number>();
    const entries = agendas.flatMap((item): ReportEntry[] => {
      const matching = rows.filter(
        (row) => row.agendaKey === agendaKey(item) && !included.has(row.row),
      );
      if (!matching.length) return [{ item }];
      matching.forEach((row) => included.add(row.row));
      return matching.map((row) => ({ item, row }));
    });
    return [
      ...entries,
      ...rows.filter((row) => !included.has(row.row)).map((row) => ({ row })),
    ];
  }, [agendas, rows]);

  function rowStatus(row: Imported) {
    const item = agendaByKey.get(row.agendaKey);
    if (row.result?.startsWith('Enviado'))
      return { label: row.result, kind: 'done' };
    if (row.result?.startsWith('Erro'))
      return { label: row.result, kind: 'issue' };
    if (
      !row.date ||
      !Number.isFinite(row.sheetMinutes) ||
      row.sheetMinutes <= 0
    )
      return { label: 'Data ou horas inválidas', kind: 'issue' };
    if (!item) return { label: 'Sem agenda vinculada', kind: 'issue' };
    if (row.date !== item.date || !clientMatches(row.customer, item))
      return { label: 'Cliente ou data diferente da agenda', kind: 'issue' };
    if ((selectedCounts.get(row.agendaKey) || 0) > 1)
      return { label: 'Agenda vinculada a várias linhas', kind: 'issue' };
    if (item.posted) return { label: 'Já apontada no Optimus', kind: 'issue' };
    if (agendaMinutes(item) !== row.sheetMinutes)
      return {
        label: `Horas diferentes: planilha ${hours(row.sheetMinutes)} / agenda líquida ${hours(agendaMinutes(item))}`,
        kind: 'issue',
      };
    if (!row.authorizedBy.trim() || !row.narrative.trim())
      return { label: 'Falta autorizado por ou narrativa', kind: 'issue' };
    return { label: 'Pronta para enviar', kind: 'ready' };
  }

  const readyCount = rows.filter(
    (row) => rowStatus(row).kind === 'ready',
  ).length;
  const selectedReady = rows.filter(
    (row) => row.selected && rowStatus(row).kind === 'ready',
  );

  async function enter(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const audit = {
        platform: 'OPTIMUS',
        appVersion: '1.0.0',
        clientAuditVersion: 1,
        session: {
          deviceType: 'desktop',
          osName: navigator.platform || 'Unknown',
          browserName: 'Browser',
          userAgent: navigator.userAgent,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      };
      const data = await jsonRequest('login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginOrEmail: login, password, audit }),
      });
      setUser(data.name || data.login || '');
      setPassword('');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadAgendas(event?: React.SyntheticEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const data = await jsonRequest(
        `agendas?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
      setAgendas(data.items || []);
      setSearched(true);
      setRows([]);
      setActiveView('dashboard');
      setAppliedPeriod({ start, end });
      setMessage(
        `${(data.items || []).length} agendas encontradas no período.`,
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    setMessage('');
    try {
      if (!/\.xlsx$/i.test(file.name))
        throw new Error('Escolha uma planilha .xlsx.');
      const sheet = await readSheet(file);
      const matrix = sheet as unknown[][];
      const headerIndex = matrix.findIndex((line) => {
        const names = line.map(normalize);
        return (
          names.includes('DATA') &&
          names.includes('CLIENTE') &&
          names.some((name) => name.startsWith('AUTORIZADO')) &&
          names.includes('HORAS')
        );
      });
      if (headerIndex < 0)
        throw new Error(
          'Cabeçalho não encontrado: Data, Cliente, Autorizado por e Horas.',
        );
      const headers = matrix[headerIndex].map(normalize);
      const dateAt = headers.indexOf('DATA');
      const clientAt = headers.indexOf('CLIENTE');
      const authorizedAt = headers.findIndex((name) =>
        name.startsWith('AUTORIZADO'),
      );
      const hoursAt = headers.indexOf('HORAS');
      const namedNarrative = headers.findIndex((name) =>
        ['NARRATIVA', 'DESCRICAO', 'ATIVIDADE'].includes(name),
      );
      const narrativeAt =
        namedNarrative >= 0 ? namedNarrative : authorizedAt + 1;
      if (narrativeAt === hoursAt || narrativeAt >= matrix[headerIndex].length)
        throw new Error('Coluna de narrativa não encontrada.');
      const imported: Imported[] = matrix
        .slice(headerIndex + 1)
        .flatMap((line, index) => {
          if (line.every((value) => cellText(value).trim() === '')) return [];
          const base = {
            row: headerIndex + index + 2,
            date: dateFromCell(line[dateAt]),
            customer: cellText(line[clientAt]).trim(),
            authorizedBy: cellText(line[authorizedAt]).trim(),
            narrative: cellText(line[narrativeAt]).trim(),
            sheetMinutes: minutesFromCell(line[hoursAt]),
          };
          return [
            { ...base, agendaKey: matchAgenda(base, agendas), selected: false },
          ];
        });
      if (!imported.length)
        throw new Error('A planilha não contém linhas de apontamento.');
      setRows(imported);
      setActiveView('review');
      setMessage(
        `${imported.length} linhas importadas. Revise as divergências antes de enviar.`,
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function updateRow(index: number, change: Partial<Imported>) {
    setRows((current) =>
      current.map((row, at) =>
        at === index ? { ...row, ...change, result: undefined } : row,
      ),
    );
  }

  async function submitSelected() {
    if (
      !selectedReady.length ||
      !window.confirm(
        `Enviar ${selectedReady.length} apontamento(s) ao Optimus?`,
      )
    )
      return;
    setBusy(true);
    setMessage('');
    let sent = 0;
    for (const row of selectedReady) {
      const item = agendaByKey.get(row.agendaKey);
      if (!item) continue;
      try {
        await jsonRequest('submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agenda: item,
            sheetDate: row.date,
            sheetCustomer: row.customer,
            authorizedBy: row.authorizedBy,
            narrative: row.narrative,
            sheetMinutes: row.sheetMinutes,
          }),
        });
        setRows((current) =>
          current.map((entry) =>
            entry.row === row.row
              ? { ...entry, selected: false, result: 'Enviado com sucesso' }
              : entry,
          ),
        );
        setAgendas((current) =>
          current.map((entry) =>
            agendaKey(entry) === row.agendaKey
              ? { ...entry, posted: true }
              : entry,
          ),
        );
        sent++;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      } catch (error) {
        setRows((current) =>
          current.map((entry) =>
            entry.row === row.row
              ? {
                  ...entry,
                  selected: false,
                  result: `Erro: ${(error as Error).message}`,
                }
              : entry,
          ),
        );
      }
    }
    setBusy(false);
    setMessage(
      `${sent} apontamento(s) enviado(s). Atualize as agendas antes de um novo envio.`,
    );
  }

  async function leave() {
    await jsonRequest('logout', { method: 'POST' }).catch(() => {});
    setUser('');
    setAgendas([]);
    setRows([]);
    setSearched(false);
    setActiveView('dashboard');
    setMessage('');
  }

  function exportReport() {
    const columns = [
      'Data',
      'Cliente',
      'Projeto',
      'Atividade',
      'Início',
      'Fim',
      'Intervalo presumido',
      'Horas líquidas agenda',
      'Na soma',
      'Apontada',
      'Horas planilha',
      'Autorizado por',
      'Narrativa',
      'Conferência',
    ];
    const content = [
      columns,
      ...reportEntries.map(({ item, row }) => {
        return [
          displayDate(item?.date || row?.date || ''),
          item?.customer || row?.customer || '',
          item ? `${item.project} · ${item.projectName}` : '',
          item ? `${item.activity} · ${item.activityName}` : '',
          item?.start || '',
          item?.end || '',
          item ? intervalLabel(item) : '',
          item ? hours(agendaMinutes(item)) : '',
          item ? nonWorkingReason(item) || 'Sim' : '',
          item?.posted ? 'Sim' : 'Não',
          row ? hours(row.sheetMinutes) : '',
          row?.authorizedBy || '',
          row?.narrative || '',
          row ? rowStatus(row).label : 'Sem linha na planilha',
        ];
      }),
    ];
    const csv = `\uFEFF${content.map((line) => line.map(csvCell).join(';')).join('\r\n')}`;
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `relatorio-optimus-${appliedPeriod.start}-${appliedPeriod.end}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!loaded)
    return (
      <main className="opt-shell">
        <p>Carregando…</p>
      </main>
    );
  return (
    <main className="opt-shell">
      <div className="opt-wrap">
        <header className="opt-header">
          <div>
            <span className="opt-eyebrow">HB SYSTEM / OPTIMUS</span>
            <h1>Gestão de apontamentos</h1>
            <p>Agendas, conferência e relatórios em um só lugar.</p>
          </div>
          {user && (
            <div className="opt-user">
              <span>{user}</span>
              <button type="button" onClick={leave}>
                Sair
              </button>
            </div>
          )}
        </header>

        {!user ? (
          <section className="opt-login opt-panel">
            <span className="opt-step">01 / Acesso</span>
            <h2>Entre com sua conta Optimus</h2>
            <form onSubmit={enter} autoComplete="off">
              <label>
                Usuário ou e-mail
                <input
                  autoComplete="off"
                  value={login}
                  onChange={(event) => setLogin(event.target.value)}
                  required
                />
              </label>
              <label>
                Senha
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              <button className="opt-primary" disabled={busy}>
                Entrar
              </button>
            </form>
            <p className="opt-note">
              A senha é usada somente para autenticar no Optimus. A sessão
              permanece em cookies protegidos.
            </p>
          </section>
        ) : (
          <>
            <section className="opt-panel opt-period">
              <div>
                <span className="opt-step">PERÍODO DE CONSULTA</span>
                <h2>Selecione as datas</h2>
              </div>
              <form onSubmit={loadAgendas}>
                <label>
                  Data inicial
                  <input
                    type="date"
                    value={start}
                    max={end}
                    onChange={(event) => setStart(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Data final
                  <input
                    type="date"
                    value={end}
                    min={start}
                    onChange={(event) => setEnd(event.target.value)}
                    required
                  />
                </label>
                <button className="opt-primary" disabled={busy}>
                  Buscar agendas
                </button>
              </form>
              {searched &&
                (start !== appliedPeriod.start ||
                  end !== appliedPeriod.end) && (
                  <p className="opt-period-notice">
                    Datas alteradas. Busque novamente para atualizar os dados
                    exibidos.
                  </p>
                )}
            </section>

            {searched && (
              <>
                <input
                  ref={fileInput}
                  className="opt-hidden"
                  type="file"
                  accept=".xlsx"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importFile(file);
                  }}
                />
                <div className="opt-workbar">
                  <nav className="opt-tabs" aria-label="Áreas do Optimus">
                    <button
                      type="button"
                      className={activeView === 'dashboard' ? 'active' : ''}
                      onClick={() => setActiveView('dashboard')}
                    >
                      Visão geral
                    </button>
                    <button
                      type="button"
                      className={activeView === 'agendas' ? 'active' : ''}
                      onClick={() => setActiveView('agendas')}
                    >
                      Agendas
                    </button>
                    {rows.length > 0 && (
                      <button
                        type="button"
                        className={activeView === 'review' ? 'active' : ''}
                        onClick={() => setActiveView('review')}
                      >
                        Conferência <span>{rows.length}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={activeView === 'report' ? 'active' : ''}
                      onClick={() => setActiveView('report')}
                    >
                      Relatórios
                    </button>
                  </nav>
                  <button
                    className="opt-primary"
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    disabled={busy}
                  >
                    Importar planilha
                  </button>
                </div>
              </>
            )}

            {searched && activeView === 'dashboard' && (
              <section className="opt-dashboard">
                <div className="opt-page-title">
                  <div>
                    <span className="opt-step">VISÃO GERAL</span>
                    <h2>Resumo do período</h2>
                    <p>
                      {displayDate(appliedPeriod.start)} a{' '}
                      {displayDate(appliedPeriod.end)} · Horas líquidas das
                      agendas em dias úteis. Feriados identificados na agenda e
                      fins de semana ficam fora da soma. Intervalo presumido de
                      1h quando o período excede 6h.
                    </p>
                  </div>
                </div>
                <div className="opt-metrics">
                  <article className="opt-metric opt-metric-primary">
                    <span>Horas em dias úteis</span>
                    <strong>
                      {hours(summary.totalMinutes)} <small>h</small>
                    </strong>
                    <p>{summary.countedCount} de {agendas.length} agendas na soma</p>
                  </article>
                  <article className="opt-metric">
                    <span>Marcadas como apontadas</span>
                    <strong>
                      {hours(summary.postedMinutes)} <small>h</small>
                    </strong>
                    <p>{summary.postedCount} agendas</p>
                  </article>
                  <article className="opt-metric">
                    <span>Não marcadas como apontadas</span>
                    <strong>
                      {hours(summary.totalMinutes - summary.postedMinutes)}{' '}
                      <small>h</small>
                    </strong>
                    <p>{summary.pendingCount} agendas</p>
                  </article>
                  <article className="opt-metric">
                    <span>Clientes</span>
                    <strong>{summary.clients.length}</strong>
                    <p>com agendas no período</p>
                  </article>
                </div>
                {summary.excludedCount > 0 && (
                  <p className="opt-accounting-note">
                    Fora da soma: {hours(summary.excludedMinutes)} h em{' '}
                    {summary.excludedCount} agenda(s) de feriado ou fim de semana.
                    Essas linhas continuam visíveis para conferência.
                  </p>
                )}
                {rows.length > 0 && (
                  <div className="opt-import-summary">
                    <div>
                      <strong>Planilha importada</strong>
                      <span>
                        {rows.length} linhas ·{' '}
                        {hours(
                          rows.reduce(
                            (sum, row) =>
                              sum +
                              (Number.isFinite(row.sheetMinutes)
                                ? row.sheetMinutes
                                : 0),
                            0,
                          ),
                        )}{' '}
                        h informadas no arquivo (soma bruta)
                      </span>
                    </div>
                    <div>
                      <strong>{readyCount} prontas</strong>
                      <span>
                        {rows.length - readyCount} exigem revisão ou já foram
                        enviadas
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveView('review')}
                    >
                      Abrir conferência
                    </button>
                  </div>
                )}
                <div className="opt-dashboard-grid">
                  <section className="opt-panel">
                    <div className="opt-section-head">
                      <div>
                        <span className="opt-step">DISTRIBUIÇÃO</span>
                        <h3>Horas por cliente</h3>
                      </div>
                    </div>
                    {summary.clients.length ? (
                      <div className="opt-client-list">
                        {summary.clients.map((client) => (
                          <div className="opt-client-line" key={client.name}>
                            <div>
                              <strong>{client.name}</strong>
                              <span>{client.count} agenda(s)</span>
                            </div>
                            <div className="opt-bar" aria-hidden="true">
                              <span
                                style={{
                                  width: `${summary.totalMinutes > 0 ? (client.minutes / summary.totalMinutes) * 100 : 0}%`,
                                }}
                              />
                            </div>
                            <b>{hours(client.minutes)} h</b>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="opt-empty">
                        Nenhuma agenda encontrada neste período.
                      </p>
                    )}
                  </section>
                  <section className="opt-panel opt-next-steps">
                    <div className="opt-section-head">
                      <div>
                        <span className="opt-step">PRÓXIMO PASSO</span>
                        <h3>Conferência da planilha</h3>
                      </div>
                    </div>
                    <p>
                      Importe o arquivo Excel para relacionar cada linha à
                      agenda, comparar as horas e conferir a narrativa e a
                      autorização.
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        rows.length
                          ? setActiveView('review')
                          : fileInput.current?.click()
                      }
                    >
                      {rows.length ? 'Ver conferência' : 'Selecionar planilha'}
                    </button>
                  </section>
                </div>
              </section>
            )}

            {searched && activeView === 'agendas' && (
              <section className="opt-panel">
                <div className="opt-section-head">
                  <div>
                    <span className="opt-step">03 / Agendas</span>
                    <h2>
                      Agendas do período <small>{agendas.length} linhas</small>
                    </h2>
                  </div>
                </div>
                <div className="opt-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Cliente</th>
                        <th>Projeto</th>
                        <th>Atividade</th>
                        <th>Horário</th>
                        <th>Intervalo presumido</th>
                        <th>Horas líquidas</th>
                        <th>Na soma</th>
                        <th>Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agendas.map((item, index) => (
                        <tr key={`${agendaKey(item)}-${index}`}>
                          <td>{item.date.split('-').reverse().join('/')}</td>
                          <td>{item.customer}</td>
                          <td>
                            {item.project} · {item.projectName}
                          </td>
                          <td>
                            {item.activity} · {item.activityName}
                          </td>
                          <td>
                            {item.start}–{item.end}
                          </td>
                          <td>{intervalLabel(item)}</td>
                          <td>{hours(agendaMinutes(item))}</td>
                          <td>{nonWorkingReason(item) || 'Sim'}</td>
                          <td>
                            <span
                              className={`opt-pill ${item.posted ? 'opt-warn' : 'opt-good'}`}
                            >
                              {item.posted
                                ? 'Já apontada'
                                : item.status || 'Disponível'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {agendas.length === 0 && (
                    <p className="opt-empty">
                      Nenhuma agenda encontrada. Você ainda pode importar a
                      planilha para conferir as linhas sem vínculo.
                    </p>
                  )}
                </div>
              </section>
            )}

            {rows.length > 0 && activeView === 'review' && (
              <section className="opt-panel">
                <div className="opt-section-head">
                  <div>
                    <span className="opt-step">04 / Conferência</span>
                    <h2>
                      Linhas da planilha{' '}
                      <small>
                        {rows.length} importadas · {readyCount} prontas
                      </small>
                    </h2>
                  </div>
                  <div className="opt-actions">
                    <button
                      type="button"
                      onClick={() =>
                        setRows((current) =>
                          current.map((row) => ({
                            ...row,
                            selected: rowStatus(row).kind === 'ready',
                          })),
                        )
                      }
                      disabled={busy || !readyCount}
                    >
                      Selecionar prontas
                    </button>
                    <button
                      className="opt-primary"
                      type="button"
                      onClick={submitSelected}
                      disabled={busy || !selectedReady.length}
                    >
                      Enviar {selectedReady.length || ''} apontamento(s)
                    </button>
                  </div>
                </div>
                <p className="opt-note">
                  Linhas já apontadas, sem vínculo ou com horas diferentes ficam
                  bloqueadas. Ajuste a planilha ou revise a agenda antes de
                  enviar.
                </p>
                <div className="opt-table-scroll">
                  <table className="opt-review">
                    <thead>
                      <tr>
                        <th>Enviar</th>
                        <th>Linha</th>
                        <th>Data</th>
                        <th>Cliente da planilha</th>
                        <th>Agenda vinculada</th>
                        <th>Horas planilha</th>
                        <th>Autorizado por</th>
                        <th>Narrativa</th>
                        <th>Conferência</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => {
                        const status = rowStatus(row);
                        return (
                          <tr
                            key={row.row}
                            className={
                              status.kind === 'issue' ? 'opt-row-issue' : ''
                            }
                          >
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Enviar linha ${row.row}`}
                                checked={
                                  row.selected && status.kind === 'ready'
                                }
                                disabled={status.kind !== 'ready' || busy}
                                onChange={(event) =>
                                  updateRow(index, {
                                    selected: event.target.checked,
                                  })
                                }
                              />
                            </td>
                            <td>{row.row}</td>
                            <td>
                              {row.date
                                ? row.date.split('-').reverse().join('/')
                                : '—'}
                            </td>
                            <td>{row.customer}</td>
                            <td>
                              <select
                                aria-label={`Agenda vinculada à linha ${row.row}`}
                                value={row.agendaKey}
                                onChange={(event) =>
                                  updateRow(index, {
                                    agendaKey: event.target.value,
                                    selected: false,
                                  })
                                }
                              >
                                <option value="">Selecione uma agenda</option>
                                {agendas
                                  .filter((item) => item.date === row.date)
                                  .map((item, at) => (
                                    <option
                                      key={`${agendaKey(item)}-${at}`}
                                      value={agendaKey(item)}
                                    >
                                      {item.customer} · {item.project} ·{' '}
                                      {item.start}–{item.end}
                                    </option>
                                  ))}
                              </select>
                            </td>
                            <td>{hours(row.sheetMinutes)}</td>
                            <td>
                              <input
                                aria-label={`Autorizado por na linha ${row.row}`}
                                value={row.authorizedBy}
                                onChange={(event) =>
                                  updateRow(index, {
                                    authorizedBy: event.target.value,
                                  })
                                }
                              />
                            </td>
                            <td>
                              <textarea
                                aria-label={`Narrativa da linha ${row.row}`}
                                rows={2}
                                value={row.narrative}
                                onChange={(event) =>
                                  updateRow(index, {
                                    narrative: event.target.value,
                                  })
                                }
                              />
                            </td>
                            <td>
                              <span
                                className={`opt-pill ${status.kind === 'ready' ? 'opt-good' : status.kind === 'done' ? 'opt-done' : 'opt-warn'}`}
                              >
                                {status.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            {searched && activeView === 'report' && (
              <section className="opt-report">
                <div className="opt-page-title opt-report-title">
                  <div>
                    <span className="opt-step">RELATÓRIOS</span>
                    <h2>Relatório do período</h2>
                    <p>
                      {displayDate(appliedPeriod.start)} a{' '}
                      {displayDate(appliedPeriod.end)} · Horas líquidas das
                      agendas em dias úteis. Feriados identificados na agenda e
                      fins de semana ficam fora da soma. Intervalo presumido de
                      1h quando o período excede 6h.
                    </p>
                  </div>
                  <div className="opt-actions opt-print-hide">
                    <button type="button" onClick={exportReport}>
                      Exportar CSV
                    </button>
                    <button type="button" onClick={() => window.print()}>
                      Imprimir / salvar PDF
                    </button>
                  </div>
                </div>
                <div className="opt-report-summary">
                  <div>
                    <span>Horas em dias úteis</span>
                    <strong>{hours(summary.totalMinutes)} h</strong>
                  </div>
                  <div>
                    <span>Marcadas como apontadas</span>
                    <strong>{hours(summary.postedMinutes)} h</strong>
                  </div>
                  <div>
                    <span>Não marcadas</span>
                    <strong>
                      {hours(summary.totalMinutes - summary.postedMinutes)} h
                    </strong>
                  </div>
                  <div>
                    <span>Fora da soma</span>
                    <strong>{hours(summary.excludedMinutes)} h</strong>
                    <small>{summary.excludedCount} de {agendas.length} agendas</small>
                  </div>
                </div>
                <section className="opt-panel">
                  <div className="opt-section-head">
                    <div>
                      <span className="opt-step">POR CLIENTE</span>
                      <h3>Consolidado</h3>
                    </div>
                  </div>
                  <div className="opt-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Agendas na soma</th>
                          <th>Horas líquidas</th>
                          <th>% do período</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.clients.map((client) => (
                          <tr key={client.name}>
                            <td>{client.name}</td>
                            <td>{client.count}</td>
                            <td>{hours(client.minutes)} h</td>
                            <td>
                              {summary.totalMinutes
                                ? (
                                    (client.minutes / summary.totalMinutes) *
                                    100
                                  ).toLocaleString('pt-BR', {
                                    maximumFractionDigits: 1,
                                  })
                                : 0}
                              %
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {summary.clients.length === 0 && (
                      <p className="opt-empty">
                        Nenhum dado para este período.
                      </p>
                    )}
                  </div>
                </section>
                <section className="opt-panel">
                  <div className="opt-section-head">
                    <div>
                      <span className="opt-step">DETALHAMENTO</span>
                      <h3>Agendas e conferência</h3>
                    </div>
                    <small>
                      {agendas.length} agendas · {rows.length} linhas importadas
                    </small>
                  </div>
                  <div className="opt-table-scroll">
                    <table className="opt-report-table">
                      <thead>
                        <tr>
                          <th>Data</th>
                          <th>Cliente</th>
                          <th>Projeto / atividade</th>
                          <th>Horário</th>
                          <th>Intervalo presumido</th>
                          <th>Horas líquidas</th>
                          <th>Na soma</th>
                          <th>Apontada</th>
                          <th>Horas planilha</th>
                          <th>Autorizado por</th>
                          <th>Narrativa</th>
                          <th>Conferência</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportEntries.map(({ item, row }, index) => {
                          return (
                            <tr
                              key={`report-${index}`}
                              className={!item ? 'opt-row-issue' : ''}
                            >
                              <td>
                                {displayDate(item?.date || row?.date || '')}
                              </td>
                              <td>{item?.customer || row?.customer || '—'}</td>
                              <td>
                                {item ? (
                                  <>
                                    {item.project} · {item.projectName}
                                    <br />
                                    <small>
                                      {item.activity} · {item.activityName}
                                    </small>
                                  </>
                                ) : (
                                  'Sem agenda vinculada'
                                )}
                              </td>
                              <td>
                                {item ? `${item.start}–${item.end}` : '—'}
                              </td>
                              <td>{item ? intervalLabel(item) : '—'}</td>
                              <td>{item ? hours(agendaMinutes(item)) : '—'}</td>
                              <td>{item ? nonWorkingReason(item) || 'Sim' : '—'}</td>
                              <td>{item?.posted ? 'Sim' : 'Não'}</td>
                              <td>{row ? hours(row.sheetMinutes) : '—'}</td>
                              <td>{row?.authorizedBy || '—'}</td>
                              <td className="opt-narrative">
                                {row?.narrative || '—'}
                              </td>
                              <td>
                                {row
                                  ? rowStatus(row).label
                                  : 'Sem linha na planilha'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {agendas.length === 0 && rows.length === 0 && (
                      <p className="opt-empty">
                        Nenhum dado para este período.
                      </p>
                    )}
                  </div>
                </section>
              </section>
            )}
          </>
        )}
        {message && <output className="opt-message">{message}</output>}
        <footer>HB System · Conferência e envio de apontamentos Optimus</footer>
      </div>
    </main>
  );
}
