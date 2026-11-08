/*
  JAVASCRIPT DO PORTAL
  As funções fazem chamadas ao servidor (server.js). Senha nunca é gravada no navegador;
  o servidor devolve um cookie HttpOnly e mantém o estado da sessão no SQLite.
*/
const $ = selector => document.querySelector(selector);
let currentUser = null;
let specialtyList = [];

// Pequena camada para padronizar JSON, cookies da sessão e mensagens de erro da API.
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir. Tente novamente.');
  return result;
}

function notify(message, kind = 'success') {
  const box = $('#notice');
  box.textContent = message;
  box.className = `portal-notice show ${kind}`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearNotice() { $('#notice').className = 'portal-notice'; $('#notice').textContent = ''; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function statusLabel(status) { return status === 'confirmed' ? 'Confirmada' : status === 'cancelled' ? 'Cancelada' : 'Aguardando confirmação'; }

// As abas só alternam as telas; cadastro público cria sempre perfil de paciente.
function chooseAuthTab(tabName) {
  const isLogin = tabName === 'login';
  $('#loginTab').classList.toggle('active', isLogin);
  $('#registerTab').classList.toggle('active', !isLogin);
  $('#loginTab').setAttribute('aria-selected', String(isLogin));
  $('#registerTab').setAttribute('aria-selected', String(!isLogin));
  $('#loginView').hidden = !isLogin;
  $('#registerView').hidden = isLogin;
  clearNotice();
}
$('#loginTab').addEventListener('click', () => chooseAuthTab('login'));
$('#registerTab').addEventListener('click', () => chooseAuthTab('register'));

async function loadSpecialties() {
  const data = await api('/api/specialties');
  specialtyList = data.specialties;
  for (const select of [$('#patientSpecialty'), $('#staffSpecialty')]) {
    select.innerHTML = '<option value="">Selecione a especialidade</option>' + specialtyList
      .map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  }
}
async function refreshAvailableSlots() {
  const select = $('#patientSlot');
  const specialtyId = $('#patientSpecialty').value;
  if (!specialtyId) { select.innerHTML = '<option value="">Selecione uma especialidade primeiro</option>'; return; }
  select.innerHTML = '<option value="">Carregando horários…</option>';
  const data = await api(`/api/slots?specialtyId=${encodeURIComponent(specialtyId)}`);
  select.innerHTML = data.slots.length
    ? '<option value="">Escolha um horário</option>' + data.slots.map(slot => `<option value="${slot.id}">${formatDate(slot.starts_at)} · ${slot.duration_minutes} min</option>`).join('')
    : '<option value="">Nenhum horário publicado; tente mais tarde</option>';
}
$('#patientSpecialty').addEventListener('change', () => refreshAvailableSlots().catch(error => notify(error.message, 'error')));

function renderPatientAppointments(appointments) {
  const target = $('#patientAppointments');
  if (!appointments.length) { target.innerHTML = '<div class="empty-list">Você ainda não tem pedidos de consulta.</div>'; return; }
  target.innerHTML = appointments.map(item => `<article class="appointment-item"><div class="appointment-row"><div><strong>${escapeHtml(item.specialty)}</strong><p>${formatDate(item.starts_at)} · ${item.duration_minutes} minutos</p></div><span class="status ${item.status}">${statusLabel(item.status)}</span></div></article>`).join('');
}
function renderStaffAppointments(appointments) {
  const target = $('#staffAppointments');
  if (!appointments.length) { target.innerHTML = '<div class="empty-list">Ainda não há pedidos de consulta.</div>'; return; }
  target.innerHTML = appointments.map(item => `<article class="appointment-item"><div class="appointment-row"><div><strong>${escapeHtml(item.patient_name)}</strong><p>${escapeHtml(item.specialty)} · ${formatDate(item.starts_at)} · ${item.duration_minutes} min</p><p class="patient-contact">${escapeHtml(item.patient_email)} · ${escapeHtml(item.patient_phone)}</p></div><span class="status ${item.status}">${statusLabel(item.status)}</span></div>${item.status === 'pending' ? `<button class="btn primary confirm-button" type="button" data-appointment-id="${item.id}">Confirmar consulta</button>` : ''}</article>`).join('');
}
async function refreshAppointments() {
  const data = await api('/api/appointments');
  if (currentUser.role === 'staff') renderStaffAppointments(data.appointments);
  else renderPatientAppointments(data.appointments);
}

// Mostra somente a área autorizada pelo papel retornado pelo servidor.
async function showDashboard(user) {
  currentUser = user;
  $('#authPanel').hidden = true;
  $('#dashboard').hidden = false;
  $('#welcome').textContent = `Olá, ${user.full_name}`;
  const isStaff = user.role === 'staff';
  $('#roleLabel').textContent = isStaff ? 'Área da equipe' : 'Área do paciente';
  $('#accountHint').textContent = isStaff ? 'Gerencie a disponibilidade e os pedidos de consulta.' : 'Escolha um horário disponível e acompanhe as confirmações.';
  $('#patientArea').hidden = isStaff;
  $('#staffArea').hidden = !isStaff;
  if (isStaff) {
    const minDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('#slotDate').min = minDate;
  }
  await refreshAppointments();
  if (!isStaff) await refreshAvailableSlots();
}

// Login: a API verifica a senha e responde com um cookie de sessão protegido.
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    event.currentTarget.reset(); await showDashboard(result.user);
  } catch (error) { notify(error.message, 'error'); }
});

// Cadastro público de paciente. O papel é definido no servidor e não pode ser alterado no cliente.
$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/api/register', { method: 'POST', body: JSON.stringify({
      fullName: form.get('fullName'), phone: form.get('phone'), email: form.get('email'), password: form.get('password'), privacyAccepted: $('#accountConsent').checked
    }) });
    event.currentTarget.reset(); await showDashboard(result.user);
    notify('Conta criada. Você já pode escolher um horário.', 'success');
  } catch (error) { notify(error.message, 'error'); }
});

// Paciente solicita um dos horários que continuam livres no banco.
$('#appointmentForm').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice();
  try {
    const result = await api('/api/appointments', { method: 'POST', body: JSON.stringify({ slotId: $('#patientSlot').value }) });
    notify(result.message); await refreshAppointments(); await refreshAvailableSlots();
  } catch (error) { notify(error.message, 'error'); await refreshAvailableSlots().catch(() => {}); }
});

// Equipe publica horário futuro para uma especialidade.
$('#slotForm').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice();
  try {
    const result = await api('/api/staff/slots', { method: 'POST', body: JSON.stringify({
      specialtyId: $('#staffSpecialty').value,
      startsAt: new Date($('#slotDate').value).toISOString(),
      durationMinutes: Number($('#slotDuration').value)
    }) });
    event.currentTarget.reset(); $('#slotDuration').value = '30';
    const minDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('#slotDate').min = minDate;
    notify(result.message);
  } catch (error) { notify(error.message, 'error'); }
});

// Confirmação só pode ser feita por sessão com papel staff; a API volta a validar a permissão.
$('#staffAppointments').addEventListener('click', async event => {
  const button = event.target.closest('.confirm-button');
  if (!button) return;
  button.disabled = true; clearNotice();
  try {
    await api(`/api/staff/appointments/${button.dataset.appointmentId}/confirm`, { method: 'POST', body: '{}' });
    notify('Consulta confirmada.'); await refreshAppointments();
  } catch (error) { button.disabled = false; notify(error.message, 'error'); }
});

// Sair apaga a sessão no banco e remove o cookie do navegador.
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  finally { currentUser = null; $('#dashboard').hidden = true; $('#authPanel').hidden = false; chooseAuthTab('login'); notify('Você saiu da sua conta.'); }
});

// Ao abrir a página, consulta a sessão existente e carrega as especialidades disponíveis.
(async function initializePortal() {
  try {
    await loadSpecialties();
    const result = await api('/api/me');
    if (result.user) await showDashboard(result.user);
  } catch (error) {
    notify(`${error.message} Confira se o servidor está em execução.`, 'error');
  }
})();
