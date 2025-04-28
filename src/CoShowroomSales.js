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

const processOrder = async (order, token) => {
  const { clientName, statusName, externalCode, store } = order
  
  try {
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
    if (orderData.status === "cancelled") return

    console.log(orderData.number, orderData.shipping_status, orderData.payment_status, statusName)

    // Si la orden ya está marcada como enviada en Tienda Nube y está pagada, la salteamos
    if (orderData.shipping_status === 'shipped' && orderData.payment_status === 'paid') {  
      return 
    }

    if (statusName === 'En Depósito' && orderData.shipping_status === 'unpacked') {
      await markAsPacked(orderData.id)
      log(`Orden ${externalCode} marcada como empaquetada`, 'info')
    }

    if (statusName === 'Entregado') {
      if (orderData.shipping_status === 'unpacked') {
        await markAsPacked(orderData.id)
        await markAsDelivered(orderData.id)
        log(`Orden ${externalCode} marcada como empaquetada y entregada`, 'info')
      }
      if (orderData.shipping_status === 'unshipped') {
        await markAsDelivered(orderData.id)
        log(`Orden ${externalCode} marcada como entregada`, 'info')
      }
      
      if ((orderData.shipping_status === 'unpacked' || orderData.shipping_status === 'unshipped') && orderData.payment_status === 'pending') {
        await markAsPaid(orderData.id, orderData.total, new Date().toISOString())
        log(`Orden ${externalCode} marcada como pagada`, 'info')
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
    
    log(`Total de órdenes obtenidas: ${data.externalOrder.length}`)
    
    const chunks = []
    const chunkSize = 5
    for (let i = 0; i < data.externalOrder.length; i += chunkSize) {
      chunks.push(data.externalOrder.slice(i, i + chunkSize))
    }

    log(`Procesando órdenes en ${chunks.length} grupos`)
    
    for (const chunk of chunks) {
      await Promise.all(chunk.map(order => processOrder(order, token)))
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