import http from 'node:http';

/**
 * A small local website for browser tasks: a bakery with a menu, a weekend
 * events page and an order form. Orders are recorded so tests can check the
 * worker really filled and submitted the form.
 */

export interface Order {
  id: string;
  name: string;
  email: string;
  item: string;
  quantity: number;
  note: string;
  at: string;
}

const MENU = [
  { id: 'sourdough', name: 'Sourdough loaf', price: 9.5 },
  { id: 'croissant', name: 'Butter croissant', price: 4.25 },
  { id: 'matcha-cake', name: 'Matcha birthday cake (serves 8)', price: 42 },
  { id: 'cinnamon', name: 'Cinnamon roll', price: 5.75 },
];

const EVENTS = [
  { day: 'Sat 10:00', title: 'Kids bread-shaping class', where: 'Fox Bakery kitchen', price: 'Free', kids: true },
  { day: 'Sat 14:00', title: 'Farmers market pop-up', where: 'Mission Dolores Park', price: 'Free', kids: true },
  { day: 'Sun 11:00', title: 'Sourdough starter workshop', where: 'Fox Bakery', price: '$25', kids: false },
  { day: 'Sun 15:00', title: 'Cupcake decorating for families', where: 'Fox Bakery', price: '$12 per child', kids: true },
];

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#fff8f1;color:#2b2118}
header{background:#c2410c;color:#fff;padding:18px 32px;font-size:22px;font-weight:600}
nav a{color:#fff;margin-right:18px;font-size:15px}
main{padding:24px 32px;max-width:860px}
table{border-collapse:collapse;width:100%;background:#fff}
td,th{border:1px solid #f0d9c4;padding:8px 10px;text-align:left}
form{background:#fff;padding:20px;border:1px solid #f0d9c4;border-radius:10px;max-width:520px}
label{display:block;margin:10px 0 4px;font-weight:600}
input,select,textarea{font:inherit;padding:8px;width:100%;box-sizing:border-box;border:1px solid #d6b89e;border-radius:6px}
button{margin-top:16px;background:#c2410c;color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;cursor:pointer}
.ok{background:#ecfdf5;border:1px solid #6ee7b7;padding:16px;border-radius:10px}
</style></head><body><header>🦊 Fox Bakery <nav style="display:inline;margin-left:24px"><a href="/">Menu</a><a href="/events">Weekend events</a><a href="/order">Order</a></nav></header><main>${body}</main></body></html>`;

export function startShop(): Promise<{ url: string; orders: Order[]; close: () => Promise<void> }> {
  const orders: Order[] = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const html = (s: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(s);
    };
    if (u.pathname === '/') {
      return html(
        page(
          'Fox Bakery — Menu',
          `<h1>Menu</h1><table><tr><th>Item</th><th>Price</th></tr>${MENU.map((m) => `<tr><td>${m.name}</td><td>$${m.price.toFixed(2)}</td></tr>`).join('')}</table><p><a href="/order">Place an order →</a></p>`,
        ),
      );
    }
    if (u.pathname === '/events') {
      return html(
        page(
          'Fox Bakery — Weekend events',
          `<h1>This weekend</h1><table><tr><th>When</th><th>What</th><th>Where</th><th>Price</th><th>Kids</th></tr>${EVENTS.map((e) => `<tr><td>${e.day}</td><td>${e.title}</td><td>${e.where}</td><td>${e.price}</td><td>${e.kids ? 'Yes' : 'No'}</td></tr>`).join('')}</table>`,
        ),
      );
    }
    if (u.pathname === '/order' && req.method === 'GET') {
      return html(
        page(
          'Fox Bakery — Order',
          `<h1>Order for pickup</h1><form method="post" action="/order">
<label for="name">Your name</label><input id="name" name="name" placeholder="Name for the order" required>
<label for="email">Email</label><input id="email" name="email" type="email" placeholder="We send the receipt here" required>
<label for="item">Item</label><select id="item" name="item">${MENU.map((m) => `<option value="${m.id}">${m.name} — $${m.price.toFixed(2)}</option>`).join('')}</select>
<label for="quantity">Quantity</label><input id="quantity" name="quantity" type="number" value="1" min="1">
<label for="note">Note</label><textarea id="note" name="note" placeholder="Writing on the cake, pickup time…"></textarea>
<button type="submit">Place order</button></form>`,
        ),
      );
    }
    if (u.pathname === '/order' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const order: Order = {
        id: 'FB-' + (1000 + orders.length + 1),
        name: f.get('name') ?? '',
        email: f.get('email') ?? '',
        item: f.get('item') ?? '',
        quantity: Number(f.get('quantity') ?? 1),
        note: f.get('note') ?? '',
        at: new Date().toISOString(),
      };
      orders.push(order);
      const item = MENU.find((m) => m.id === order.item);
      return html(
        page(
          'Fox Bakery — Order confirmed',
          `<div class="ok"><h1>Order confirmed</h1><p>Order number <b>${order.id}</b></p><p>${order.quantity} × ${item?.name ?? order.item} for ${order.name}. Total $${((item?.price ?? 0) * order.quantity).toFixed(2)}, pay at pickup.</p><p>Receipt sent to ${order.email}.</p></div>`,
        ),
      );
    }
    if (u.pathname === '/api/orders') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(orders));
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, orders, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
