import dotenv from 'dotenv'
import fs from 'fs/promises'
import path from 'path'

dotenv.config()

const COSHOWROOM_EMAIL = process.env.COSHOWROOM_EMAIL
const COSHOWROOM_PASSWORD = process.env.COSHOWROOM_PASSWORD
const AUTH_TIENDANUBE = process.env.AUTH_TIENDANUBE

// Retail Studio (retailstudio.dev) reemplazó a Copago el 22/11/2026. Es un Supabase: la URL y la
// anon key son las públicas del front, y con el usuario de la marca el RLS sólo deja ver lo nuestro.
const RETAIL_STUDIO_URL = 'https://toswmxhhyllzornqnago.supabase.co'
const RETAIL_STUDIO_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvc3dteGhoeWxsem9ybnFuYWdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzODY2NzUsImV4cCI6MjExMDk2MjY3NX0.bpaF05rZkBJrV03jsZU00PCAOK7hjU4kxN0KL0p_lP8'

const ESTADOS = {
  en_deposito: 'En Depósito',
  entregado: 'Entregado',
}

let tnUnauthorized = false

const log = (message, type = 'info') => {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`)
}

export const loginCo = async () => {
  try {
    const response = await fetch(`${RETAIL_STUDIO_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: RETAIL_STUDIO_ANON_KEY,
      },
      body: JSON.stringify({
        email: COSHOWROOM_EMAIL,
        password: COSHOWROOM_PASSWORD,
      }),
    })

    if (!response.ok) {
      throw new Error(`Error en login: ${response.status} ${await response.text()}`)
    }

    const data = await response.json()
    log('Login exitoso en Retail Studio')
    return data.access_token
  } catch (error) {
    log(`Error en login: ${error.message}`, 'error')
    throw error
  }
}

const PAGE_SIZE = 1000

const fetchPedidos = async (token, desde) => {
  const pedidos = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      select: 'id,codigo_externo,estado,cliente_nombre,puntos_venta!pedidos_punto_venta_id_fkey(nombre)',
      created_at: `gte.${desde.toISOString()}`,
      order: 'id.asc',
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    const response = await fetch(`${RETAIL_STUDIO_URL}/rest/v1/pedidos?${params}`, {
      headers: { apikey: RETAIL_STUDIO_ANON_KEY, Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      throw new Error(`Error obteniendo pedidos: ${response.status} ${await response.text()}`)
    }
    const page = await response.json()
    pedidos.push(...page)
    if (page.length < PAGE_SIZE) return pedidos
  }
}

const processOrder = async (order, token, updatedOrders) => {
  const { clientName, statusName, externalCode, store } = order
  
  try {
    // Validar que externalCode no esté vacío
    if (!externalCode || externalCode.trim() === '') {
      console.log(`Orden sin externalCode - Cliente: ${clientName}, Status: ${statusName}`)
      return
    }

    // replace(' ', '') sacaba solo el PRIMER espacio, y después el find comparaba
    // contra el externalCode crudo: " 96608" o "97963 " nunca matcheaban.
    const codigo = externalCode.replace(/\s/g, '')

    const URL = `https://api.tiendanube.com/v1/1705915/orders?q=${codigo}`
    const response = await fetch(URL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authentication: AUTH_TIENDANUBE,
        'User-Agent': 'En Palabras (enpalabrass@gmail.com)',
      },
    })

    if (!response.ok) {
      if (response.status === 401) tnUnauthorized = true
      console.log(`Error consultando orden ${externalCode}: ${response.status}`)
      return
    }

    const orders = await response.json()

    // Buscar específicamente la orden que coincida con el number
    const orderData = orders.find(order => order.number.toString() === codigo)

    if (!orderData) {
      console.log(`No se encontró orden en TN con number = ${externalCode}`)
      return
    }

    if (orderData.status === "cancelled") return

    // NUEVA VALIDACIÓN: Solo procesar si es pickup-point
    if (orderData.shipping !== 'pickup-point') {
      console.log(`Orden ${externalCode} no es pickup-point (es ${orderData.shipping}), salteando procesamiento`)
      return
    }

    console.log(orderData.number, orderData.shipping_status, orderData.payment_status, statusName)

    // Si la orden ya está marcada como enviada en Tienda Nube y está pagada, la salteamos
    if ((orderData.shipping_status === 'shipped' || orderData.shipping_status === 'delivered') && orderData.payment_status === 'paid') {  
      return 
    }

    // Array para trackear las acciones de esta orden
    const orderActions = []

    if (statusName === 'En Depósito' && orderData.shipping_status === 'unpacked') {
      if (await markAsPacked(orderData.id)) orderActions.push('empaquetada')
    }

    if (statusName === 'Entregado') {
      if (orderData.shipping_status === 'unpacked') {
        if (await markAsPacked(orderData.id) && await markAsDelivered(orderData.id)) {
          orderActions.push('empaquetada y entregada')
        }
      }
      else if (orderData.shipping_status === 'unshipped') {
        if (await markAsDelivered(orderData.id)) orderActions.push('entregada')
      }

      if (orderData.payment_status === 'pending') {
        if (await markAsPaid(orderData.id)) orderActions.push('pagada')
      }
    }

    // Si se realizaron acciones, guardar en el array
    if (orderActions.length > 0) {
      updatedOrders.push({
        number: externalCode,
        client: clientName,
        actions: orderActions.join(', '),
        coStatus: statusName
      })
    }

  } catch (error) {
    console.error(`Error procesando orden ${externalCode}:`, error)
  }
}

export const salesCo = async (token) => {
  try {
    // Ventana de 90 días: from/to filtran por fecha de creación, y el p99 desde
    // que se crea la orden hasta que se entrega es de 61 días. Cubre ~99,5% de
    // las entregas con ~1050 órdenes, muy por debajo del tope de 5000 del
    // endpoint. Con un año eran 7246 y la API devolvía solo las 5000 más
    // nuevas, perdiendo los primeros cuatro meses en silencio.
    const DIAS_VENTANA = 90

    const desde = new Date()
    desde.setDate(desde.getDate() - DIAS_VENTANA)

    log(`Consultando pedidos desde ${desde.toISOString().slice(0, 10)} (${DIAS_VENTANA} días)`)

    const externalOrder = (await fetchPedidos(token, desde)).map((pedido) => ({
      clientName: pedido.cliente_nombre ?? '',
      statusName: ESTADOS[pedido.estado] ?? pedido.estado,
      externalCode: pedido.codigo_externo ?? '',
      store: pedido.puntos_venta?.nombre ?? '',
    }))
    const data = { externalOrder }

    log(`Total de órdenes obtenidas: ${data.externalOrder.length}`)
    
    // Array para guardar las órdenes actualizadas
    const updatedOrders = []
    
    const chunks = []
    const chunkSize = 10
    for (let i = 0; i < data.externalOrder.length; i += chunkSize) {
      chunks.unshift(data.externalOrder.slice(i, i + chunkSize))
    }

    log(`Procesando órdenes en ${chunks.length} grupos`)
    
    for (const chunk of chunks) {
      await Promise.all(chunk.map(order => processOrder(order, token, updatedOrders)))
      if (tnUnauthorized) {
        throw new Error('Tiendanube rechazó AUTH_TIENDANUBE (401): hay que actualizar el secret')
      }
    }

    // Mostrar resumen de órdenes actualizadas
    log('==========================================')
    log('RESUMEN DE ÓRDENES ACTUALIZADAS')
    log('==========================================')
    
    if (updatedOrders.length > 0) {
      log(`Total de órdenes actualizadas: ${updatedOrders.length}`)
      console.log('\nDetalle de actualizaciones:')
      updatedOrders.forEach((order, index) => {
        console.log(`${index + 1}. Orden #${order.number} - ${order.client}`)
        console.log(`   Estado CoShowroom: ${order.coStatus}`)
        console.log(`   Acciones: ${order.actions}`)
      })
    } else {
      log('No se realizaron actualizaciones de órdenes')
    }
    
    log('==========================================')
    log('Proceso completado exitosamente')
    
    return {
      ...data,
      updatedOrders
    }
  } catch (error) {
    log(`Error en proceso principal: ${error.message}`, 'error')
    throw error
  }
}

const TN_HEADERS = {
  'Content-Type': 'application/json',
  Authentication: AUTH_TIENDANUBE,
  'User-Agent': 'En Palabras (enpalabrass@gmail.com)',
}

// Devuelve true solo si TN aceptó la escritura. Antes ninguna de estas
// funciones miraba la respuesta, así que el script reportaba en verde
// acciones que nunca ocurrieron.
const tnWrite = async (accion, id, url, method, body) => {
  try {
    const response = await fetch(url, {
      method,
      headers: TN_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (!response.ok) {
      if (response.status === 401) tnUnauthorized = true
      log(`Fallo ${accion} en orden ${id}: ${response.status} ${await response.text()}`, 'error')
      return false
    }
    return true
  } catch (error) {
    log(`Error de red en ${accion} para la orden ${id}: ${error.message}`, 'error')
    return false
  }
}

const markAsPacked = (id) =>
  tnWrite('empaquetado', id, `https://api.tiendanube.com/v1/1705915/orders/${id}/pack`, 'POST')

const markAsDelivered = (id) =>
  tnWrite('entrega', id, `https://api.tiendanube.com/v1/1705915/orders/${id}/fulfill`, 'POST', {
    shipping_tracking_number: 'NO_TRACK_NUMBER',
    shipping_tracking_url: `https://www.enpalabras.com.ar/`,
    notify_customer: false,
  })

// PUT /orders/{id} con status "paid". El endpoint de transactions NO sirve
// acá: es exclusivo de payment apps y no liquida órdenes con gateway offline
// (verificado — creaba la transacción y la orden seguía impaga).
const markAsPaid = (id) =>
  tnWrite('pago', id, `https://api.tiendanube.com/v1/1705915/orders/${id}`, 'PUT', {
    status: 'paid',
  })
