const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Variables de entorno (Configurables en Render)
const BOT_TOKEN = process.env.BOT_TOKEN || 'TU_TOKEN_DE_TELEGRAM';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'TU_ID_DE_GRUPO_ADMIN';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || 'TU_GOOGLE_SHEET_ID';

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());
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

// FUNCIÓN PARA LEER EL CATÁLOGO DESDE GOOGLE SHEETS EN TIEMPO REAL
async function obtenerCatalogoDesdeSheets() {
  if (!GOOGLE_SHEET_ID || GOOGLE_SHEET_ID === 'TU_GOOGLE_SHEET_ID') {
    console.log("⚠️ GOOGLE_SHEET_ID no configurado. Usando catálogo vacío temporal.");
    return {};
  }

  const url = 'https://docs.google.com/spreadsheets/d/' + GOOGLE_SHEET_ID + '/gviz/tq?tqx=out:json';
  
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url);
    const text = await response.text();
    
    // Limpiar el JSON que devuelve Google Sheets gviz
    const jsonString = text.substring(47, text.length - 2);
    const json = JSON.parse(jsonString);
    
    const productos = {};
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
    return productos;
  } catch (err) {
    console.error("Error leyendo Google Sheets:", err);
    return {};
  }
}

// 1. ENDPOINT API PARA EL FRONTEND EN VERCEL (Catálogo Dinámico desde la Nube)
app.get('/api/productos', async (req, res) => {
  const productosDinamicos = await obtenerCatalogoDesdeSheets();
  res.json({ categorias: CATEGORIAS, productos: productosDinamicos, tasas: TASAS, provincias: PROVINCIAS });
});

// 2. ENDPOINT API PARA RECIBIR NUEVOS PEDIDOS DESDE LA MINI APP
app.post('/api/crear-pedido', async (req, res) => {
  try {
    const { clienteId, nombreCliente, provincia, metodo, carrito, datosEntrega, total } = req.body;
    
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

    // Notificar al Grupo de Administradores
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      '🚨 *NUEVO PEDIDO DESDE MINI APP (' + ordenId + ')*\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '👤 Cliente: ' + nombreCliente + ' (ID: `' + clienteId + '`)\n' +
      '📍 Destino: ' + provincia + '\n' +
      '💳 Método: ' + metodo + ' | 💰 *Total:* `' + total + '`\n\n' +
      '🏠 *Entrega:* ' + datosEntrega + '\n\n' +
      'Por favor, espere el comprobante de pago del cliente.',
      { parse_mode: 'Markdown' }
    );

    res.json({ success: true, ordenId: ordenId, message: 'Pedido registrado con éxito' });
  } catch (err) {
    console.error("Error creando pedido:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. GENERADOR DE FACTURA PDF
function generarFacturaPDF(ordenId, clienteNombre, destino, metodo, total, detalle, callback) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const filename = path.join(__dirname, 'factura_' + ordenId + '.pdf');
  const stream = fs.createWriteStream(filename);

  doc.pipe(stream);

  doc.fontSize(20).text('COMBO-EXPRESS DESDE RUSIA', { align: 'center' });
  doc.fontSize(10).text('Comprobante Oficial de Compra y Entrega', { align: 'center' });
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

  doc.fontSize(9).text('Gracias por confiar en nuestros servicios. Su pedido está en proceso de entrega en Cuba.', { align: 'center' });
  doc.text('Soporte General: +79153745462 | Atención en Cuba: +5351849868', { align: 'center' });

  doc.end();

  stream.on('finish', () => {
    callback(filename);
  });
}

// 4. WEBHOOK DE TELEGRAM
app.post('/bot' + BOT_TOKEN, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// Manejo de botones de administración inline para aprobar pago
bot.action(/aprobar_(.+)_(.+)/, async (ctx) => {
  const clienteId = ctx.match[1];
  const ordenId = ctx.match[2];

  let pedidoInfo = null;
  if (PEDIDOS_USUARIOS[clienteId]) {
    const ped = PEDIDOS_USUARIOS[clienteId].find(p => p.id === ordenId);
    if (ped) {
      ped.estado = '🔄 Procesando / En preparación';
      pedidoInfo = ped;
    }
  }

  try {
    await bot.telegram.sendMessage(
      clienteId,
      '🎉 *¡PAGO VERIFICADO Y PEDIDO APROBADO!* 🎉\n' +
      'Tu pedido *' + ordenId + '* ha sido confirmado. Aquí tienes tu **Factura Oficial en PDF**.',
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

    await ctx.editMessageCaption('✅ Orden ' + ordenId + ' Aprobada y Factura enviada.');
  } catch (e) {
    await ctx.reply('⚠️ Error al aprobar.');
  }
});

// Iniciar servidor en Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Backend Express con Google Sheets corriendo en puerto ' + PORT);
  if (process.env.RENDER_EXTERNAL_URL) {
    await bot.telegram.setWebhook(process.env.RENDER_EXTERNAL_URL + '/bot' + BOT_TOKEN);
    console.log('Webhook configurado en: ' + process.env.RENDER_EXTERNAL_URL);
  }
});
