import { loginCo, salesCo } from './src/CoShowroomSales.js'


// Que quede todo en una misma funcion
const main = async () => {
  const token = await loginCo() 
  await salesCo(token)
}

main()

