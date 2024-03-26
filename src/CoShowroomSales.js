import dotenv from 'dotenv'

dotenv.config()

const COSHOWROOM_LOGINURL = process.env.COSHOWROOM_LOGINURL
const COSHOWROOM_EMAIL = process.env.COSHOWROOM_EMAIL
const COSHOWROOM_PASSWORD = process.env.COSHOWROOM_PASSWORD
const AUTH_TIENDANUBE = process.env.AUTH_TIENDANUBE

export const loginCo = async () => {
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
    return {
      error: {
        status: response.status,
        statusText: response.statusText,
      },
    }
  }

  const data = await response.json()

  return data.token
}

export const salesCo = async (token) => {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  const date = `${mm}/${dd}/${yyyy}`

  const URL = `https://api.copagopos.com/externalOrder/2000/0?from=6/1/2021&to=${date}`
  // const URL = `https://api.copagopos.com/externalOrder/10/0?from=6/1/2021&to=12/8/2023`

  const response = await fetch(URL, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
  })

  if (!response.ok) {
    return {
      error: {
        status: response.status,
        statusText: response.statusText,
      },
    }
  }

  const data = await response.json()

  const mappedData = data.externalOrder.map((order) => {
    const { clientName, statusName, externalCode, store } = order

    return {
      clientName,
      statusName,
      externalCode,
      store,
    }
  })

  for (let i = 0; i < mappedData.length; i++) {
    const { externalCode, statusName } = mappedData[i]
    const URL = `https://api.tiendanube.com/v1/1705915/orders?q=${externalCode.replace(
      ' ',
      ''
    )}`

    const response = await fetch(URL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authentication: AUTH_TIENDANUBE,
        'User-Agent': 'En Palabras (enpalabrass@gmail.com)',
      },
    })

    if (!response.ok) {
      console.log(response.status, response.statusText)
      console.log('No se encontró el pedido en Tienda Nube', externalCode)
      // return {
      //   error: {
      //     status: response.status,
      //     statusText: response.statusText,
      //   },
      // }
    }
    const data = await response.json()
    // console.log(data)
    try {
      console.log(data[0].number, data[0].next_action, statusName)
    } catch (error) {
      console.log(error)
    }

    if (statusName === 'En Depósito') {
      if (data[0]?.next_action === 'waiting_packing') {
        console.log('waiting_packing', 'En Depósito')
        await markAsPacked(data[0].id)
      }
    }

    if (statusName === 'Entregado') {
      if (data[0]?.next_action === 'close') {
        continue
      }

      if (data[0]?.next_action === 'waiting_packing') {
        console.log('waiting_packing', 'Entregado')
        await markAsPacked(data[0].id)
        await markAsDelivered(data[0].id)
      }

      if (data[0]?.next_action === 'waiting_client_pickup') {
        console.log('waiting_client_pickup', 'Entregado')

        await markAsDelivered(data[0].id)
      }

      if (data[0]?.next_action === 'waiting_manual_confirmation') {
        console.log('waiting_manual_confirmation', 'Entregado')
        await markAsPaid(data[0].id, data[0].total, date)
      }
    }

    if (statusName === 'En Tránsito') {
    }

    if (statusName === 'Cancelado') {
    }
  }

  return data
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
