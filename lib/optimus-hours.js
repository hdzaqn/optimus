// O extrato do Optimus registra 1h de intervalo para períodos acima de 6h.
// O horário padrão do intervalo é 11:50–12:50, inclusive em agendas à tarde.
export function minutes(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return NaN;
  const [hour, minute] = value.split(':').map(Number);
  return hour < 24 && minute < 60 ? hour * 60 + minute : NaN;
}

export function intervalFor(start, end) {
  const duration = minutes(end) - minutes(start);
  return Number.isFinite(duration) && duration > 6 * 60
    ? { start: '11:50', end: '12:50', minutes: 60 }
    : { start: '00:00', end: '00:00', minutes: 0 };
}

export function netMinutes(start, end) {
  const duration = minutes(end) - minutes(start);
  return duration - intervalFor(start, end).minutes;
}
