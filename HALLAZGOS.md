# Hallazgos — sincronización CoShowroom ↔ Tienda Nube

Relevamiento del 10/8/2026. Cubre este repo y `CoShowRoom`, que son las dos
mitades del mismo circuito.

## Cómo encaja todo

```
Cliente compra en TN con retiro en sucursal
        ↓  webhooks order/created + order/paid
   [CoShowRoom]  →  Google Sheets, una pestaña por sucursal
        ↓  el local prepara y entrega
   CoShowroom marca "En Depósito" → "Entregado" en su POS
        ↓
   [CoShowSystem]  →  pack / fulfill / paid en TN
```

`CoShowRoom` es la ida, este repo es la vuelta.

Aparte y sin relación con estos dos repos: las ventas **propias** del showroom
(mostrador, no originadas en TN) se cargan a Postgres desde otra planilla
(`Export Data`) vía `server_en_palabras`. El endpoint `/externalOrder` que usa
este repo **solo tiene órdenes originadas en TN** (tipos `Pickup` y `Moto`) y no
incluye montos: ni total, ni ítems, ni medio de pago.

---

## Resuelto en este repo

### markAsPaid nunca funcionó

Usaba `POST /orders/{id}/transactions` con el payment provider
`En Palabras Pagos` (`7bb85609-…`). Ese endpoint es exclusivo de payment apps y
**no liquida órdenes con gateway `offline`**, que son todas las de mostrador. La
transacción se creaba con status `paid` y la orden seguía impaga.

Como ninguna función chequeaba `response.ok`, el script lo reportaba como éxito
y reintentaba cada corrida. Se acumularon **162 transacciones fantasma sobre 4
órdenes** ($7.263.788 nominales). La #105825 llegó a 53 transacciones de $37.791
sin quedar paga.

El provider además está desactivado (`enabled: false`) y su `checkout_js_url`
apunta a un servicio que devuelve 404. Ninguna orden usa ese gateway desde hace
meses.

**Solución:** `PUT /orders/{id}` con `{"status": "paid"}`. La documentación dice
que `payment_status` no es escribible por PUT y que la única vía es una
transacción — es falso. Verificado contra la API: la orden pasa a `paid` y se
setea `paid_at`. El `status` de la orden no se toca (queda `open`).

### Ventana de consulta de un año

`from`/`to` filtran por fecha de **creación**, y el endpoint corta en 5000. Con
365 días había 7246 órdenes: la API devolvía las 5000 más nuevas y se perdían
los primeros cuatro meses en silencio.

Medido sobre 1354 órdenes ya resueltas, el tiempo de creación a entrega es:
mediana 2 días, p90 11, p95 20, p99 61, máximo 139.

**Solución:** ventana de 90 días. Cubre ~99,5% de las entregas con ~1050
órdenes, sin acercarse al tope. La corrida bajó de ~5 min a ~1m30s.

### Trim del externalCode

`externalCode.replace(' ', '')` sacaba solo el primer espacio, y el `find`
después comparaba contra el `externalCode` crudo. Códigos como `" 96608"` o
`"97963 "` nunca matcheaban y se reportaban como "no encontrada en TN".

---

## Abierto

### 1. Los dos repos definen distinto qué es "retiro en CoShowroom"

```
CoShowRoom    →  ¿shipping_option contiene COSHOWROOM / RETIRO / SUCURSAL?
CoShowSystem  →  ¿shipping === 'pickup-point'?
```

Sobre 1200 órdenes desde febrero, divergen en **106**: las que tienen
`shipping: api_950305` y `shipping_option: "Punto de retiro"`.

El criterio equivocado es el de `CoShowRoom`. Esas órdenes son de otro proveedor
de puntos de retiro — se distingue porque su `shipping_option_reference` es
numérico (5791, 1328, 4169) mientras el de CoShowroom es un ULID fijo
(`01GQFQ7BWNMGM2GFV4J8MMNYWS`). La palabra "RETIRO" las captura de más.

Terminan en la pestaña `Ventas` por el fallback de `determineSheetName`, y
`checkIds` lee esa pestaña en cada webhook, así que la hace crecer al pedo.

**Es la duplicación que conviene atacar: el criterio, no los repos.** Una función
compartida de cinco líneas.

### 2. El webhook de CoShowRoom no valida firma

`api/notifications/tiendanube.js` acepta cualquier POST. Sin HMAC, sin secret,
sin chequeo de origen. Cualquiera con la URL puede mandar `{id, event}` y
disparar una consulta a la API de TN y una escritura en la planilla.

El daño está acotado (solo escribe órdenes reales, pagas y de retiro), pero es un
endpoint público que dispara escrituras. TN firma los webhooks; habría que
verificarlo.

### 3. El fallback a la pestaña `Ventas` es mudo

Si `determineSheetName` no reconoce la sucursal devuelve `'Ventas'` sin log ni
alerta. Hoy no muerde: solo hay órdenes de Recoleta (172) y San Isidro (48), las
dos mapeadas. Pero el mapeo tiene 4 sucursales y CoShowroom tiene 6 — **Barrio
Norte y Edits no están**. El día que habiliten una como punto de retiro en TN,
esas ventas se van a `Ventas` y nadie en el local las ve.

Latente, no activo.

### 4. Cola larga fuera de la ventana de 90 días

~5 de cada 1000 órdenes se retiran después de los 90 días (el máximo observado
fue 139). Quedan fuera de la ventana y no hay reintento posterior. Se resuelve
con una corrida diaria de ventana larga y paginación (`/externalOrder` pagina
por offset), o con un cruce manual cada tanto.

### 5. Órdenes canceladas sin reconciliar

11 órdenes figuran `Cancelado` en CoShowroom y `delivered` + `paid` en TN.
Ningún repo mira esa dirección: el script solo chequea el cancelado del lado TN.

### 6. Basura en externalCode

CoShowroom tiene filas con códigos que no son números de orden: `"DESESTIMAR"`,
`"ERROR"`, `"001"`, `"102628 BIS"`, `"99954-CAMBIO"`, nombres de clientes. Cada
una genera un 404 por corrida. Es data entry, no código.

### 7. Menores

- `fs` y `path` importados sin usar; `store` destructurado sin usar.
- `chunks.unshift()` procesa los lotes en orden inverso. Inofensivo pero confuso.
- Los webhooks `packed`, `fulfilled` y `cancelled` están suscriptos en TN y sus
  handlers devuelven 200 sin hacer nada.

---

## Backfill aplicado

El 10/8/2026 se marcaron como pagas **17 órdenes** ($719.180) que CoShowroom daba
por `Entregado` y en TN seguían impagas. Criterio: `offline` + `pickup-point` +
no cancelada en TN + `Entregado` en CoShowroom. Se excluyeron 79 que no cumplían
(76 aún no entregadas, 2 canceladas en CoShowroom, 1 inexistente).

Las 162 transacciones fantasma ya creadas **no se borraron**. Sigue pendiente
decidir si se limpian.

---

## Sobre unificar los dos repos

No conviene mergearlos entre sí. Son ~700 líneas en total, tienen formas de
ejecución distintas (servidor de webhooks siempre encendido vs. batch cada 2h) y
hoy fallan por separado, que es una propiedad deseable. Además ya existen
`en-palabras-core` y `ep-tn-app` como destinos naturales; crear un tercer hogar
ahora es laburo para deshacer después.

Lo que sí conviene compartir es el criterio del punto 1.
