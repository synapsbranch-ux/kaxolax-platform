import { z } from 'zod'
import { relativePathSchema } from './names.js'

const positiveInt = z.coerce.number().int().positive()
const coordinate = z.coerce.number()

/** Du code vers le PDF : GET .../synctex/code?file=&line=&column= */
export const synctexCodeQuerySchema = z.object({
  file: relativePathSchema,
  line: positiveInt,
  column: z.coerce.number().int().nonnegative().default(0),
})
export type SynctexCodeQuery = z.infer<typeof synctexCodeQuerySchema>

/** Du PDF vers le code : GET .../synctex/pdf?page=&h=&v= (points PDF, origine en haut à gauche). */
export const synctexPdfQuerySchema = z.object({
  page: positiveInt,
  h: coordinate,
  v: coordinate,
})
export type SynctexPdfQuery = z.infer<typeof synctexPdfQuerySchema>

export const pdfPositionSchema = z.object({
  page: z.number().int().positive(),
  h: z.number(),
  v: z.number(),
  width: z.number(),
  height: z.number(),
})
export type PdfPosition = z.infer<typeof pdfPositionSchema>

export const codePositionSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
})
export type CodePosition = z.infer<typeof codePositionSchema>

export const synctexCodeResponseSchema = z.object({ pdf: z.array(pdfPositionSchema) })
export type SynctexCodeResponse = z.infer<typeof synctexCodeResponseSchema>

export const synctexPdfResponseSchema = z.object({ code: z.array(codePositionSchema) })
export type SynctexPdfResponse = z.infer<typeof synctexPdfResponseSchema>
