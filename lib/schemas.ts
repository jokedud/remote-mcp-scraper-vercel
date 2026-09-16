import { z } from "zod";

export const urlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "http(s) URLs only");

export const proxySchema = z
  .string()
  .url()
  .refine(
    (u) => /^(https?|socks4|socks4a|socks5|socks5h):\/\//i.test(u),
    "proxy must be http(s):// or socks4(а)/5(h)://",
  )
  .optional();

export const takeScreenshotSchema = {
  url: urlSchema.describe("Page URL to capture"),
  width: z.number().int().min(200).max(3840).default(1280),
  height: z.number().int().min(200).max(3840).default(720),
  fullPage: z.boolean().default(false),
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
    .default("load"),
  delayMs: z.number().int().min(0).max(10_000).default(0),
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().int().min(1).max(100).default(80),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(30_000),
  proxy: proxySchema,
  userAgent: z.string().max(500).optional(),
};

export const fetchUrlSchema = {
  url: urlSchema,
  method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.string().max(1_000_000).optional(),
  timeoutMs: z.number().int().min(500).max(60_000).optional(),
  maxRetries: z.number().int().min(0).max(5).default(2),
  maxBytes: z.number().int().min(1024).max(20 * 1024 * 1024).optional(),
  proxy: proxySchema,
  userAgent: z.string().max(500).optional(),
  followRedirects: z.boolean().default(true),
};

export const movieMetadataSchema = {
  title: z.string().min(1).max(200),
  year: z.number().int().min(1888).max(2100).optional(),
  provider: z.enum(["auto", "tmdb", "omdb", "wikipedia"]).default("auto"),
};

export const pingSchema = {
  message: z.string().max(500).optional(),
};
