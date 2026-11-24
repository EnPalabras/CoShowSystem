# CoShowroom Sync System

Sistema de sincronización automática de órdenes entre CoShowroom (sistema de ventas físicas) y Tienda Nube (e-commerce) para mantener ambas plataformas actualizadas en tiempo real.

## 📋 Objetivo

Este proyecto automatiza la sincronización del estado de órdenes entre el sistema de ventas presenciales CoShowroom y la plataforma de e-commerce Tienda Nube, evitando la necesidad de actualización manual y reduciendo errores operativos.

## 🎯 Funcionalidades Principales

- **Autenticación automática** con CoShowroom mediante credenciales
- **Consulta masiva** de órdenes de ventas del último año
- **Sincronización de estados** entre ambas plataformas:
  - Estado de empaquetado
  - Estado de entrega
  - Estado de pago
- **Procesamiento en lotes** para optimizar el rendimiento
- **Sistema de logs** con timestamps para auditoría

## 🔧 Funcionamiento

### Flujo del Sistema

1. **Login en CoShowroom**: Obtiene el token de autenticación
2. **Consulta de órdenes**: Recupera todas las órdenes del último año desde CoShowroom
3. **Procesamiento por lotes**: Divide las órdenes en grupos de 10 para procesamiento paralelo
4. **Sincronización de estados**:
   - Si la orden está "En Depósito" en CoShowroom → Marca como empaquetada en Tienda Nube
   - Si la orden está "Entregado" en CoShowroom → Actualiza estado de entrega y pago en Tienda Nube
5. **Logging**: Registra todas las operaciones con timestamps

### Estados Manejados

| Estado CoShowroom | Acción en Tienda Nube |
|-------------------|----------------------|
| En Depósito | Marcar como empaquetada |
| Entregado | Marcar como entregada y pagada |

## 📁 Estructura del Proyecto

```
CoShowSystem/
├── index.js                 # Punto de entrada principal
├── src/
│   └── CoShowroomSales.js  # Lógica de sincronización
├── .env                     # Variables de entorno (no commitear)
├── .env.example            # Plantilla de variables de entorno
├── package.json            # Dependencias del proyecto
└── README.md              # Este archivo
```

## 🚀 Instalación

1. **Clonar el repositorio**
```bash
git clone [url-del-repositorio]
cd CoShowSystem
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Configurar variables de entorno**
```bash
cp .env.example .env
# Editar .env con las credenciales reales
```

## ⚙️ Configuración

### Variables de Entorno

Crear un archivo `.env` en la raíz del proyecto con las siguientes variables:

```env
# CoShowroom API

COSHOWROOM_EMAIL=tu_email@ejemplo.com
COSHOWROOM_PASSWORD=tu_password_seguro

# Tienda Nube API
AUTH_TIENDANUBE="bearer tu_token_de_api"
```

⚠️ **IMPORTANTE**: Nunca commitear el archivo `.env` con credenciales reales.

## 💻 Uso

### Ejecución Manual
```bash
npm start
```

### Ejecución con Logs
```bash
npm start > sync_$(date +%Y%m%d_%H%M%S).log 2>&1
```

## 🔄 Automatización Recomendada

### Con Cron (Linux/Mac)

Agregar al crontab para ejecutar cada hora:
```bash
0 * * * * cd /ruta/al/proyecto && npm start >> /var/log/coshowroom-sync.log 2>&1
```

### Con Task Scheduler (Windows)

1. Abrir Task Scheduler
2. Crear nueva tarea
3. Configurar trigger: Cada hora
4. Acción: Ejecutar `npm start` en la carpeta del proyecto

### Con PM2 (Recomendado para Producción)

```bash
# Instalar PM2
npm install -g pm2

# Configurar proceso
pm2 start index.js --name "coshowroom-sync" --cron "0 * * * *"

# Guardar configuración
pm2 save
pm2 startup
```

## 🛠️ Mantenimiento

### Tareas Regulares

1. **Revisar logs semanalmente** para detectar errores o anomalías
2. **Validar sincronización** comparando estados entre plataformas mensualmente
3. **Actualizar dependencias** cada trimestre:
   ```bash
   npm update
   npm audit fix
   ```

### Monitoreo Recomendado

- **Alertas de error**: Configurar notificaciones cuando el proceso falle
- **Métricas de sincronización**: Cantidad de órdenes procesadas/actualizadas
- **Tiempo de ejecución**: Monitorear si aumenta significativamente
- **Rate limits**: Verificar límites de API de Tienda Nube

### Backup de Configuración

Mantener respaldo seguro de:
- Variables de entorno
- Credenciales de API
- Configuración de automatización

## 🔍 Debugging

### Logs Detallados

El sistema incluye logs con timestamps para cada operación:
```
[2024-12-21T10:30:00.000Z] INFO: Login exitoso en CoShowroom
[2024-12-21T10:30:01.000Z] INFO: Total de órdenes obtenidas: 150
[2024-12-21T10:30:05.000Z] INFO: Orden #12345 marcada como entregada
```

### Errores Comunes

| Error | Causa | Solución |
|-------|-------|----------|
| Error en login | Credenciales incorrectas | Verificar .env |
| Error 429 | Rate limit excedido | Reducir tamaño de lotes |
| Timeout | Muchas órdenes | Reducir rango de fechas |

## 🔒 Seguridad

- **Nunca exponer credenciales** en el código o logs
- **Rotar tokens** regularmente (cada 3-6 meses)
- **Usar HTTPS** siempre para las comunicaciones
- **Limitar permisos** del token de Tienda Nube al mínimo necesario
- **Validar certificados SSL** en producción

## 📊 Performance

- Procesa ~500 órdenes en 2-3 minutos
- Usa procesamiento en paralelo (lotes de 10)
- Evita re-procesar órdenes ya sincronizadas
- Cache de tokens para reducir llamadas de login

## 🤝 Contribuir

1. Fork del proyecto
2. Crear rama feature (`git checkout -b feature/nueva-funcionalidad`)
3. Commit cambios (`git commit -am 'Agrega nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Crear Pull Request

## 📝 Notas Importantes

- El sistema consulta órdenes del último año por defecto
- Solo actualiza órdenes que requieren cambios (optimización)
- No procesa órdenes canceladas
- Respeta el estado actual en Tienda Nube (no sobrescribe sin verificar)

## ⚠️ Limitaciones Conocidas

- API de Tienda Nube tiene límite de 300 requests/hora
- CoShowroom requiere re-autenticación cada 24 horas
- No maneja órdenes parcialmente entregadas
- Procesamiento secuencial por lotes (no totalmente paralelo)

## 📞 Soporte

Para problemas o consultas:
- Email: enpalabrass@gmail.com
- Issues: [Crear issue en GitHub]

## 📄 Licencia

ISC License - Ver archivo LICENSE para más detalles.

---

**Última actualización**: Diciembre 2024
**Versión**: 1.0.0