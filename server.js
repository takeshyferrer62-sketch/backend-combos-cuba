const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const BOT_TOKEN = process.env.BOT_TOKEN || '8716309397:AAGmzXXo0OQIp3Fnve-B-I5dZuB7W4nsWIU';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '-1004266293162';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://combo-express.vercel.app';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1-uReh_K2tqu29HbQaDDOajrJg61krGiuegilw21Nqto';

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Aumentar el límite de tamaño para aceptar imágenes de comprobantes en Base64 sin errores
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({ origin: FRONTEND_URL }));

const TASAS = { USD: 1, RUB: 96, EUR: 0.92, CUP: 320, MLC: 1, USDT: 1 };

const PROVINCIAS = [
  'La Habana', 'Santiago de Cuba', 'Matanzas', 'Villa Clara', 
  'Holguín', 'Camagüey', 'Pinar del Río', 'Artemisa', 
  'Mayabeque', 'Cienfuegos', 'Sancti Spíritus', 'Ciego de Ávila', 
  'Las Tunas', 'Granma', 'Guantánamo', 'Isla de la Juventud'
];

const CATEGORIAS = {
  res: '🥩 Res y Carneros',
  cerdo: '🐖 Cerdo',
  arroz: '🍚 Arroz',
  granos: '🫘 Granos y Frijoles',
  aceite: '🌻 Aceites y Grasas',
  embutidos: '🌭 Embutidos y Chorizos',
  detergente: '🧼 Detergente y Aseo',
  galletas: '🍪 Galletas, Pastas y Aperitivos',
  leche_polvo: '🍼 Leche en Polvo',
  jugos: '🧃 Jugos, Refrescos y Néctares',
  leche_liq: '🥛 Leche Líquida y Sustitutos',
  cafe: '☕ Café',
  equipos: '🔦 Equipos Recargables',
  conservas: '🥫 Conservas y Enlatados'
};

const PEDIDOS_USUARIOS = {};

async function obtenerCatalogoDesdeSheets() {
  if (!GOOGLE_SHEET_ID || GOOGLE_SHEET_ID === 'TU_GOOGLE_SHEET_ID') {
    return {};
  }
  const url = 'https://docs.google.com/spreadsheets/d/' + GOOGLE_SHEET_ID + '/gviz/tq?tqx=out:json';
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url);
    const text = await response.text();
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');
    if (firstOpen === -1 || lastClose === -1) return {};
    const json = JSON.parse(text.substring(firstOpen, lastClose + 1));
    const productos = {};
    if (json.table && json.table.rows) {
      json.table.rows.forEach(row => {
        const id = row.c[0] ? row.c[0].v : null;
        if (id) {
          productos[id] = {
            id: id,
            cat: row.c[1] ? row.c[1].v : 'otros',
            nombre: row.c[2] ? row.c[2].v : 'Sin nombre',
            marca: row.c[3] ? row.c[3].v : 'Genérica',
            precioBaseUSD: row.c[4] ? parseFloat(row.c[4].v) : 0,
            imagen: row.c[5] ? row.c[5].v : '/images/default.jpg'
          };
        }
      });
    }
    return productos;
  } catch (err) {
    console.error("Error leyendo Google Sheets:", err.message);
    return {};
  }
}

app.get('/api/productos', async (req, res) => {
  const productosDinamicos = await obtenerCatalogoDesdeSheets();
  res.json({ categorias: CATEGORIAS, productos: productosDinamicos, tasas: TASAS, provincias: PROVINCIAS });
});

app.post('/api/crear-pedido', async (req, res) => {
  try {
    const { clienteId, nombreCliente, provincia, metodo, carrito, datosEntrega, total, comprobanteBase64 } = req.body;
    const ordenId = 'PED-' + Math.floor(1000 + Math.random() * 9000);
    
    let detalle = '';
    Object.values(carrito).forEach(item => {
      detalle += '- ' + item.cantidad + 'x ' + item.nombre + ' (' + item.subtotal + ')\n';
    });

    if (!PEDIDOS_USUARIOS[clienteId]) PEDIDOS_USUARIOS[clienteId] = [];
    
    const nuevoPedido = {
      id: ordenId,
      estado: '⏳ En espera (Verificando pago)',
      total: total,
      fecha: new Date().toLocaleDateString(),
      detalle: detalle,
      provincia: provincia,
      metodo: metodo,
      nombreCliente: nombreCliente || 'Cliente'
    };
    
    PEDIDOS_USUARIOS[clienteId].push(nuevoPedido);

    const mensajeAdmin = 
      '🚨 *NUEVO PEDIDO CON COMPROBANTE (' + ordenId + ')*\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '👤 Cliente: ' + nombreCliente + ' (ID: `' + clienteId + '`)\n' +
      '📍 Destino: ' + provincia + '\n' +
      '💳 Método: ' + metodo + ' | 💰 *Total:* `' + total + '`\n\n' +
      '🏠 *Entrega:* ' + datosEntrega + '\n\n' +
      'Por favor, verifique el comprobante y apruebe o rechace el pago.';

    const markup = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Aprobar Pago', `aprobar_${clienteId}_${ordenId}`),
        Markup.button.callback('❌ Rechazar', `rechazar_${clienteId}_${ordenId}`)
      ]
    ]);

    if (comprobanteBase64 && comprobanteBase64.startsWith('data:image')) {
      const base64Data = comprobanteBase64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      await bot.telegram.sendPhoto(ADMIN_CHAT_ID, { source: buffer }, { caption: mensajeAdmin, parse_mode: 'Markdown', ...markup });
    } else {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, mensajeAdmin, { parse_mode: 'Markdown', ...markup });
    }

    res.json({ success: true, ordenId: ordenId, message: 'Pedido y comprobante registrados con éxito' });
  } catch (err) {
    console.error("Error creando pedido:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function generarFacturaPDF(ordenId, clienteNombre, destino, metodo, total, detalle, callback) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const filename = path.join(__dirname, 'factura_' + ordenId + '.pdf');
  const stream = fs.createWriteStream(filename);

  doc.pipe(stream);
  doc.fontSize(20).text('COMBO-EXPRESS DESDE RUSIA', { align: 'center' });
  doc.fontSize(10).text('Comprobante Oficial de Compra y Factura de Envío', { align: 'center' });
  doc.moveDown(2);

  doc.fontSize(12).text('Número de Orden: ' + ordenId);
  doc.text('Fecha: ' + new Date().toLocaleDateString());
  doc.text('Cliente: ' + clienteNombre);
  doc.text('Destino en Cuba: ' + destino);
  doc.text('Método de Pago: ' + metodo);
  doc.moveDown(1);

  doc.text('---------------------------------------------------------------------------------------------------------');
  doc.text('DETALLE DEL COMBO:');
  doc.text('---------------------------------------------------------------------------------------------------------');
  doc.fontSize(10).text(detalle);
  doc.moveDown(1);

  doc.text('---------------------------------------------------------------------------------------------------------');
  doc.fontSize(12).text('TOTAL ABONADO: ' + total, { align: 'right' });
  doc.moveDown(3);

  doc.fontSize(9).text('Su pago ha sido verificado con éxito. Su pedido se encuentra en proceso de envío a Cuba.', { align: 'center' });
  doc.text('Soporte General: +79252481911', { align: 'center' });
  doc.end();

  stream.on('finish', () => { callback(filename); });
}

app.post('/bot' + BOT_TOKEN, (req, res) => {
  bot.handleUpdate(req.body, res);
});

bot.action(/aprobar_(.+)_(.+)/, async (ctx) => {
  const clienteId = ctx.match[1];
  const ordenId = ctx.match[2];

  let pedidoInfo = null;
  if (PEDIDOS_USUARIOS[clienteId]) {
    const ped = PEDIDOS_USUARIOS[clienteId].find(p => p.id === ordenId);
    if (ped) {
      ped.estado = '🚚 Pago Aprobado / En proceso de envío';
      pedidoInfo = ped;
    }
  }

  try {
    await bot.telegram.sendMessage(
      clienteId,
      '🎉 *¡PAGO VERIFICADO Y APROBADO!* 🎉\n' +
      'Tu pedido *' + ordenId + '* ha sido confirmado. Ya va en camino al proceso de envío a Cuba.\n' +
      'Aquí tienes tu **Factura Oficial en PDF**.',
      { parse_mode: 'Markdown' }
    );

    if (pedidoInfo) {
      generarFacturaPDF(ordenId, pedidoInfo.nombreCliente, pedidoInfo.provincia, pedidoInfo.metodo, pedidoInfo.total, pedidoInfo.detalle, async (pdfPath) => {
        try {
          await bot.telegram.sendDocument(clienteId, { source: pdfPath, filename: 'Factura_' + ordenId + '.pdf' });
          fs.unlinkSync(pdfPath);
        } catch (e) {}
      });
    }

    await ctx.editMessageCaption('✅ Orden ' + ordenId + ' Aprobada con éxito. Factura enviada al cliente.');
  } catch (e) {
    await ctx.reply('⚠️ Error al aprobar el pedido.');
  }
});

bot.action(/rechazar_(.+)_(.+)/, async (ctx) => {
  const clienteId = ctx.match[1];
  const ordenId = ctx.match[2];

  if (PEDIDOS_USUARIOS[clienteId]) {
    const ped = PEDIDOS_USUARIOS[clienteId].find(p => p.id === ordenId);
    if (ped) ped.estado = '❌ Pago Rechazado (Comprobante inválido)';
  }

  try {
    await bot.telegram.sendMessage(
      clienteId,
      '❌ *PAGO RECHAZADO*\n' +
      'Lo sentimos, el comprobante de tu pedido *' + ordenId + '* no pudo ser verificado. Por favor contacta a soporte.',
      { parse_mode: 'Markdown' }
    );
    await ctx.editMessageCaption('❌ Orden ' + ordenId + ' Rechazada.');
  } catch (e) {
    await ctx.reply('⚠️ Error al rechazar.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Backend Express corriendo en puerto ' + PORT);
  if (process.env.RENDER_EXTERNAL_URL) {
    await bot.telegram.setWebhook(process.env.RENDER_EXTERNAL_URL + '/bot' + BOT_TOKEN);
  }
});
