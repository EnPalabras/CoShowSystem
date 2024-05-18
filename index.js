import { loginCo, salesCo } from './src/CoShowroomSales.js'

const setOrders = async () => {
  const token = await loginCo()
  const salesCoShowroom = await salesCo(token)
}
// Comentario para no desactivar workflow

setOrders()
