import dotenv from 'dotenv'
import fs from 'fs/promises'
import path from 'path'

dotenv.config()

const COSHOWROOM_LOGINURL = process.env.COSHOWROOM_LOGINURL
const COSHOWROOM_EMAIL = process.env.COSHOWROOM_EMAIL
const COSHOWROOM_PASSWORD = process.env.COSHOWROOM_PASSWORD
const AUTH_TIENDANUBE = process.env.AUTH_TIENDANUBE
const SHIPPED_ORDERS_CACHE = process.env.CACHE_FILE_PATH || 'shipped_orders_cache.json'

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

const getShippedOrders = async () => {
  try {
    // Intentar leer el archivo existente
    const data = await fs.readFile(SHIPPED_ORDERS_CACHE, 'utf-8')
    try {
      const orders = new Set(JSON.parse(data).shippedOrders)
      log(`Caché cargado: ${orders.size} órdenes procesadas`)
      return orders
    } catch (parseError) {
      log(`Error al parsear el caché, intentando recuperar backup: ${parseError.message}`, 'warn')
      // Si hay error al parsear, intentar leer el backup
      const backupData = await fs.readFile(`${SHIPPED_ORDERS_CACHE}.backup`, 'utf-8')
      const orders = new Set(JSON.parse(backupData).shippedOrders)
      log(`Caché recuperado desde backup: ${orders.size} órdenes`, 'info')
      return orders
    }
  } catch (error) {
    // Si no existe el archivo o hay error al leerlo
    log('No se encontró archivo de caché existente, verificando backup', 'warn')
    try {
      const backupData = await fs.readFile(`${SHIPPED_ORDERS_CACHE}.backup`, 'utf-8')
      const orders = new Set(JSON.parse(backupData).shippedOrders)
      log(`Caché recuperado desde backup: ${orders.size} órdenes`, 'info')
      // Restaurar el backup como archivo principal
      await fs.writeFile(SHIPPED_ORDERS_CACHE, backupData)
      return orders
    } catch (backupError) {
      log('Creando nuevo archivo de caché', 'info')
      const emptyCache = JSON.stringify({ shippedOrders: [] })
      await fs.writeFile(SHIPPED_ORDERS_CACHE, emptyCache)
      await fs.writeFile(`${SHIPPED_ORDERS_CACHE}.backup`, emptyCache)
      return new Set()
    }
  }
}

const addToShippedOrders = async (orderId) => {
  try {
    const shippedOrders = await getShippedOrders()
    if (!shippedOrders.has(orderId)) {
      shippedOrders.add(orderId)
      const cacheData = JSON.stringify({ 
        shippedOrders: Array.from(shippedOrders),
        lastUpdate: new Date().toISOString()
      }, null, 2)

      // Primero crear el backup
      await fs.writeFile(`${SHIPPED_ORDERS_CACHE}.backup`, cacheData)
      // Luego actualizar el archivo principal
      await fs.writeFile(SHIPPED_ORDERS_CACHE, cacheData)
      
      log(`Orden ${orderId} agregada al caché (total: ${shippedOrders.size})`)
    }
  } catch (error) {
    log(`Error al actualizar caché de órdenes enviadas: ${error.message}`, 'error')
    throw error // Propagar el error para mejor tracking
  }
}

const processOrder = async (order, token, shippedOrders) => {
  const { clientName, statusName, externalCode, store } = order
  
  try {
    // Si la orden ya fue marcada como enviada, la saltamos
    if (shippedOrders.has(externalCode)) {
      return
    }

    const URL = `https://api.tiendanube.com/v1/1705915/orders?q=${externalCode.replace(' ', '')}`
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

    const [orderData] = await response.json()
    if (!orderData) return

    // Si la orden ya está marcada como enviada en Tienda Nube o está pagada, la agregamos al caché
    if (orderData.shipping_status === 'shipped' || orderData.payment_status === 'paid') {
      await addToShippedOrders(externalCode)
      return
    }

    console.log(orderData.number, orderData.next_action, statusName)

    if (statusName === 'En Depósito' && orderData.next_action === 'waiting_packing') {
      await markAsPacked(orderData.id)
    }

    if (statusName === 'Entregado') {
      if (orderData.next_action === 'waiting_packing') {
        await markAsPacked(orderData.id)
        await markAsDelivered(orderData.id)
        await addToShippedOrders(externalCode)
      } else if (orderData.next_action === 'waiting_client_pickup') {
        await markAsDelivered(orderData.id)
        await addToShippedOrders(externalCode)
      } else if (orderData.next_action === 'waiting_manual_confirmation') {
        await markAsPaid(orderData.id, orderData.total, new Date().toISOString())
        await addToShippedOrders(externalCode)
      }
    }
  } catch (error) {
    console.error(`Error procesando orden ${externalCode}:`, error)
  }
}

export const salesCo = async (token) => {
  try {
    const today = new Date()
    const oneYearAgo = new Date(today)
    oneYearAgo.setFullYear(today.getFullYear() - 1)
    
    const formattedToday = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`
    const formattedOneYearAgo = `${String(oneYearAgo.getMonth() + 1).padStart(2, '0')}/${String(oneYearAgo.getDate()).padStart(2, '0')}/${oneYearAgo.getFullYear()}`
    
    log(`Consultando órdenes desde ${formattedOneYearAgo} hasta ${formattedToday}`)
    
    const URL = `https://api.copagopos.com/externalOrder/2000/0?from=${formattedOneYearAgo}&to=${formattedToday}`

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
    const shippedOrders = await getShippedOrders()
    
    log(`Total de órdenes obtenidas: ${data.externalOrder.length}`)
    
    const chunks = []
    const chunkSize = 5
    for (let i = 0; i < data.externalOrder.length; i += chunkSize) {
      chunks.push(data.externalOrder.slice(i, i + chunkSize))
    }

    log(`Procesando órdenes en ${chunks.length} grupos`)
    
    for (const chunk of chunks) {
      await Promise.all(chunk.map(order => processOrder(order, token, shippedOrders)))
    }

    log('Proceso completado exitosamente')
    return data
  } catch (error) {
    log(`Error en proceso principal: ${error.message}`, 'error')
    throw error
  }
}

const markAsPacked = async (id) => {
  const URL_PACK = `https://api.tiendanube.com/v1/1705915/orders/${id}/pack`
  const headers = {
    'Content-Type': 'application/json',
    Authentication: AUTH_TIENDANUBE,
    'User-Agent': 'En Palabras (enpalabrass@gmail.com)',
  }

  await fetch(URL_PACK, {
    method: 'POST',
    headers,
  })
}

const markAsDelivered = async (id) => {
  const URL_DELIVER = `https://api.tiendanube.com/v1/1705915/orders/${id}/fulfill`
  const headers = {
    'Content-Type': 'application/json',
    Authentication: AUTH_TIENDANUBE,
    'User-Agent': 'En Palabras (enpalabrass@gmail.com)',
  }

  await fetch(URL_DELIVER, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      shipping_tracking_number: 'NO_TRACK_NUMBER',
      shipping_tracking_url: `https://www.enpalabras.com.ar/`,
      notify_customer: false,
    }),
  })
}

const markAsPaid = async (id, value, date) => {
  const datePaid = new Date(date).toISOString()

  const URL_PAID = `https://api.tiendanube.com/v1/1705915/orders/${id}/transactions`

  const headers = {
    'Content-Type': 'application/json',
    Authentication: AUTH_TIENDANUBE,
    'User-Agent': 'En Palabras (enpalabrass@gmail.com)',
  }

  const body = {
    payment_provider_id: '7bb85609-5d0f-4a41-bb45-b12ae22697fd',
    payment_method: {
      type: 'cash',
    },
    first_event: {
      amount: {
        value: `${value}`,
        currency: 'ARS',
      },
      type: 'sale',
      status: 'success',
      happened_at: datePaid,
    },
  }

  await fetch(URL_PAID, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}