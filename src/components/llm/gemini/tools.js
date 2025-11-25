import { Type } from "@google/genai";

// --- Tool Definitions ---

export const standardAnswerTools = {
    functionDeclarations: [
        {
            name: "getCurrentTime",
            description: "Get the current date and time for a *specific, validated IANA timezone string*. If a user mentions a location (e.g., 'San Diego'), first use 'get_iana_timezone_for_location_tool' to resolve it to an IANA timezone, then call this function with that IANA string. Defaults to UTC if no timezone is provided.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    timezone: {
                        type: Type.STRING,
                        description: "REQUIRED if a specific location's time is needed. The IANA timezone name (e.g., 'America/Los_Angeles', 'Europe/Paris')."
                    }
                },
            }
        },
        {
            name: "get_iana_timezone_for_location_tool",
            description: "Resolves a human-readable location name (city, region) into its standard IANA timezone string. This should be called BEFORE calling 'getCurrentTime' if a user specifies a location.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    location_name: {
                        type: Type.STRING,
                        description: "The city or location name mentioned by the user (e.g., 'San Diego', 'Paris')."
                    }
                },
                required: ["location_name"]
            }
        }
    ]
};

// Configure search tool for Gemini 2.5 models (JavaScript format)
export const searchTool = [{ googleSearch: {} }];
