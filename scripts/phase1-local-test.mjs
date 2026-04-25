import WebSocket from 'ws';

const consoleBase = process.env.CONSOLE_BASE_URL || 'http://127.0.0.1:11000';
const relayUrl = process.env.RELAY_WS_URL || 'ws://127.0.0.1:11001/ws';
const adminUsername = process.env.TEST_ADMIN_USERNAME || 'admin';
const adminPassword = process.env.TEST_ADMIN_PASSWORD || 'test123';

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`${url} -> ${JSON.stringify(data)}`);
  }
  return data;
}

function connectAndWait(label, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => reject(new Error(`${label} timeout`)), 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'joined') {
        clearTimeout(timeout);
        resolve({ ws, msg });
      }
      if (msg.type === 'error' || msg.type === 'server/reject') {
        clearTimeout(timeout);
        reject(new Error(`${label} rejected ${JSON.stringify(msg)}`));
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const login = await postJson(`${consoleBase}/api/auth/login`, {
  username: adminUsername,
  password: adminPassword,
});

const created = await postJson(
  `${consoleBase}/api/sessions/create`,
  { max_participants: 5 },
  { authorization: `Bearer ${login.token}` }
);

const performerName = 'Tester One';
const performer = await postJson(`${consoleBase}/api/sessions/join-token`, {
  session_id: created.session.session_id,
  password: created.session.session_password,
  name: performerName,
  client_uuid: 'client-test-1',
});

const host = await connectAndWait('host', {
  type: 'hello',
  session_id: created.session.session_id,
  role: 'host',
  name: `Host:${adminUsername}`,
  join_token: created.session.host_join_token,
});

const guest = await connectAndWait('performer', {
  type: 'hello',
  session_id: created.session.session_id,
  role: 'performer',
  name: performerName,
  client_uuid: 'client-test-1',
  join_token: performer.join_token,
});

console.log(JSON.stringify({
  ok: true,
  session_id: created.session.session_id,
  host_role: host.msg.data.role,
  performer_role: guest.msg.data.role,
  invite_url: created.session.invite_url,
}, null, 2));

host.ws.close();
guest.ws.close();
