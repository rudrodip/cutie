/* eslint-disable @next/next/no-img-element */
import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { aiResponseSchema } from "@/lib/schema";
import { Redis } from "@upstash/redis";
import { waitUntil } from "@vercel/functions";

const CACHE_DURATION = 3 * 60 * 60 * 1000;
const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN,
});

const size = {
  width: 1120,
  height: 1240,
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest",
  generationConfig: { responseMimeType: "application/json" },
});

async function getCachedOrFetchResult(query: string) {
  const cacheKey = `meme:${query}`;
  const cachedResult = await redis.get(cacheKey);

  if (cachedResult) {
    try {
      return JSON.parse(JSON.stringify(cachedResult as string));
    } catch (error) {
      console.error("Error parsing cached result:", error);
    }
  }

  const prompt = generatePrompt(query);
  const result = (await model.generateContent(prompt, {})).response.text();

  try {
    const parsedResult = JSON.parse(result);
    const validatedResult = aiResponseSchema.parse(parsedResult);

    await redis.set(cacheKey, JSON.stringify(validatedResult), { px: CACHE_DURATION });

    return validatedResult;
  } catch (error) {
    console.error("Error parsing or validating API result:", error);
    throw new Error("Invalid response from AI model");
  }
}

const logRequest = async () => {
  return redis.incr("total_requests");
};

const logIpData = async (
  ip: string,
  ref: string,
  query: string,
  output: string
) => {
  return redis.rpush(
    `ip:${ip}`,
    JSON.stringify({
      ref: ref || "",
      query,
      output,
    })
  );
};

export const runtime = "edge";
export const maxDuration = 60;
export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get("query");
    const ref = request.nextUrl.searchParams.get("ref");
    const ip = request.ip;
    if (!query)
      return fetch(new URL("../../../../public/og.png", import.meta.url));

    const [font, base, { output }] = await Promise.all([
      fetch(
        new URL("../../../../assets/fonts/impact.ttf", import.meta.url)
      ).then((res) => res.arrayBuffer()),
      fetch(new URL("../../../../assets/base.png", import.meta.url)).then(
        (res) => res.blob()
      ),
      getCachedOrFetchResult(query),
    ]);
    const base64 = await blobToBase64(base);

    waitUntil(Promise.all([
      logRequest(),
      ip ? logIpData(ip, ref || "", query, output) : Promise.resolve()
    ]));

    return new ImageResponse(
      (
        <div
          style={{
            height: "100%",
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            backgroundColor: "#fff",
            fontSize: 60,
            fontWeight: 600,
          }}
        >
          <div
            style={{
              display: "flex",
              width: "100%",
              height: "100%",
            }}
          >
            <img src={`data:image/png;base64,${base64}`} alt="" />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignContent: "center",
              textAlign: "center",
              position: "absolute",
              top: "46%",
              left: "23%",
              fontSize: 200,
            }}
          >
            {output}
          </div>
        </div>
      ),
      {
        ...size,
        fonts: [
          {
            name: "Inter",
            data: font,
            style: "normal",
            weight: 400,
          },
        ],
      }
    );
  } catch (error) {
    console.log(error);
    return new Response("Error generating meme", { status: 500 });
  }
}

const generatePrompt = (query: string) => `
I am making a meme website, and you're the core ai behind it. Your task is to generate good structured response for me. So, basically i ask users "what do you want?", and the user responds. based on the query, i show a meme. But there are some special cases. the user query can be in hindi, please convert it to english if its not in english.

Your output structure: { output: string } json schema
Just output an emoji based on the query

Examples:
1. query: "laptop", response: { output: "💻" }
2. query: "tea", response: { output: "🍵" }
3. query: "coffee", response: { output: "☕" }

ALWAYS OUTPUT EMOJIS as output.

Here's the query: ${query}
`;

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString("base64");
}
