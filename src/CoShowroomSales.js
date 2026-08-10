import dotenv from 'dotenv'
import fs from 'fs/promises'
import path from 'path'

dotenv.config()

const COSHOWROOM_LOGINURL = process.env.COSHOWROOM_LOGINURL
const COSHOWROOM_EMAIL = process.env.COSHOWROOM_EMAIL
const COSHOWROOM_PASSWORD = process.env.COSHOWROOM_PASSWORD
const AUTH_TIENDANUBE = process.env.AUTH_TIENDANUBE

const log = (message, type = 'info') => {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`)
}

export const loginCo = async () => {
  try {
    const response = await fetch(COSHOWROOM_LOGINURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: COSHOWROOM_EMAIL,
        password: COSHOWROOM_PASSWORD,
      }),
    })

    if (!response.ok) {
      throw new Error(`Error en login: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    log('Login exitoso en CoShowroom')
    return data.token
  } catch (error) {
    log(`Error en login: ${error.message}`, 'error')
    throw error
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

    const formatDate = (date) =>
      `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`

    const today = new Date()
    const desde = new Date(today)
    desde.setDate(today.getDate() - DIAS_VENTANA)

    const formattedToday = formatDate(today)
    const formattedDesde = formatDate(desde)

    log(`Consultando órdenes desde ${formattedDesde} hasta ${formattedToday} (${DIAS_VENTANA} días)`)

    const URL = `https://api.copagopos.com/externalOrder/5000/0?from=${formattedDesde}&to=${formattedToday}`

    const response = await fetch(URL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
      },
    })

    if (!response.ok) {
      throw new Error(`Error obteniendo órdenes: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    
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
