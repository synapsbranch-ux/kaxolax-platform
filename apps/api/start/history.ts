/*
|--------------------------------------------------------------------------
| Tâches périodiques de l'historique (processus web uniquement)
|--------------------------------------------------------------------------
*/
import app from '@adonisjs/core/services/app'
import { startHistoryScheduler } from '#services/history_scheduler'

const stop = await startHistoryScheduler()
app.terminating(() => {
  stop()
})
